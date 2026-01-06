from __future__ import annotations

from uuid import uuid4

import fitz  # PyMuPDF
from fastapi import HTTPException

from redaction_service import state
from redaction_service.learning import (
    _compute_pdf_learning_terms,
    _extract_blacklist_phrases_from_box_text,
    _extract_lines_for_bulk,
    _extract_manual_match_key_for_rect,
    _extract_text_for_learning,
)
from redaction_service.models import KeepBox, RedactionBox, RedactionResponse, SessionActionsRequest
from redaction_service.payloads import sanitize_box_payload


def apply_pdf_session_actions(
    document_id: str,
    record,
    request: SessionActionsRequest,
) -> RedactionResponse:
    if (record.payload_type or "pdf") != "pdf":
        raise HTTPException(400, "Only PDF sessions support box actions")

    list_manager = state.list_manager

    boxes: list[dict] = record.redaction_boxes or []
    manual: list[dict] = record.manual_boxes or []
    keep: list[dict] = record.keep_boxes or []

    for box in boxes:
        box.setdefault("box_id", f"ai_{uuid4().hex[:12]}")
        box.setdefault("is_auto", True)
        box.setdefault("is_removed", False)
    for box in manual:
        box.setdefault("box_id", f"manual_{uuid4().hex[:12]}")
        box.setdefault("is_auto", False)
        box.setdefault("is_removed", False)
    for box in keep:
        box.setdefault("box_id", f"keep_{uuid4().hex[:12]}")
        box.setdefault("is_removed", False)

    def _find_box(target_id: str) -> tuple[str, int, dict] | None:
        for idx, b in enumerate(boxes):
            if b.get("box_id") == target_id:
                return ("auto", idx, b)
        for idx, b in enumerate(manual):
            if b.get("box_id") == target_id:
                return ("manual", idx, b)
        return None

    def _find_keep_box(target_id: str) -> tuple[int, dict] | None:
        for idx, b in enumerate(keep):
            if b.get("box_id") == target_id:
                return (idx, b)
        return None

    def _set_removed(target_id: str, removed: bool) -> dict:
        found = _find_box(target_id)
        if not found:
            raise HTTPException(400, f"Unknown box_id: {target_id}")
        _kind, _idx, b = found
        before = bool(b.get("is_removed"))
        b["is_removed"] = bool(removed)
        return {"type": "REMOVE_BOX" if before else "RESTORE_BOX", "box_id": target_id}

    def _apply_one(action: dict, *, record_history: bool = True) -> dict | None:
        action = dict(action)
        action_type = str(action.get("type") or "").upper().strip()
        if not action_type:
            raise HTTPException(400, "Action missing 'type'")

        should_record_history = record_history

        if action_type == "UNDO":
            if not record.history_past:
                return None
            entry = record.history_past.pop()
            inverse = entry.get("inverse")
            if inverse:
                _apply_one(inverse, record_history=False)
            record.history_future.append(entry)
            return None

        if action_type == "REDO":
            if not record.history_future:
                return None
            entry = record.history_future.pop()
            redo_action = entry.get("action")
            if redo_action:
                _apply_one(redo_action, record_history=False)
            record.history_past.append(entry)
            return None

        def _ai_match_key(b: dict) -> str:
            raw = b.get("text")
            if raw is None:
                return ""
            normalized = list_manager.normalize(str(raw))
            return normalized or ""

        def _ensure_manual_match_keys() -> None:
            missing = [b for b in manual if b.get("manual_match_key") is None]
            if not missing:
                return
            if not record.detected_path:
                return
            try:
                doc = fitz.open(record.detected_path)
            except Exception:
                return
            try:
                for b in missing:
                    try:
                        page = doc.load_page(int(b.get("page", 0)))
                        rect = fitz.Rect(float(b["x0"]), float(b["y0"]), float(b["x1"]), float(b["y1"]))
                        key = _extract_manual_match_key_for_rect(page, rect)
                    except Exception:
                        key = ""
                    b["manual_match_key"] = key
            finally:
                doc.close()

        inverse: dict | None = None
        if action_type in {"REMOVE_BOX", "REMOVE_AUTO_BOX"}:
            target_id = action.get("box_id")
            if not target_id:
                raise HTTPException(400, "REMOVE_BOX requires box_id")
            inverse = _set_removed(target_id, True)
        elif action_type in {"RESTORE_BOX", "RESTORE_AUTO_BOX"}:
            target_id = action.get("box_id")
            if not target_id:
                raise HTTPException(400, "RESTORE_BOX requires box_id")
            inverse = _set_removed(target_id, False)
        elif action_type == "BULK_ADD_MANUAL_BOX_SIMILAR":
            box_payload = action.get("box") or {}
            try:
                parsed = RedactionBox(**box_payload)
            except Exception as exc:
                raise HTTPException(400, f"Invalid manual box payload: {exc}") from exc

            # Extract one-or-more line keys under the user's box. If the selection spans multiple
            # lines, bulk matching operates line-by-line (never as a paragraph).
            selections: list[tuple[str, fitz.Rect]] = []
            if record.detected_path:
                try:
                    doc = fitz.open(record.detected_path)
                    page = doc.load_page(parsed.page)
                    rect = fitz.Rect(parsed.x0, parsed.y0, parsed.x1, parsed.y1)
                    selections = _extract_lines_for_bulk(page, rect)
                    doc.close()
                except Exception:
                    selections = []

            if not record.detected_path or not selections:
                action = {"type": "ADD_MANUAL_BOX", "box": box_payload}
                return _apply_one(action, record_history=record_history)

            overlay_text = parsed.overlay_text
            max_matches = 250

            def _rect_key(page_num: int, x0: float, y0: float, x1: float, y1: float) -> tuple:
                return (
                    int(page_num),
                    round(float(x0), 2),
                    round(float(y0), 2),
                    round(float(x1), 2),
                    round(float(y1), 2),
                )

            existing_by_rect: dict[tuple, dict] = {}
            for b in manual:
                try:
                    rk = _rect_key(
                        int(b.get("page", 0)),
                        float(b.get("x0", 0)),
                        float(b.get("y0", 0)),
                        float(b.get("x1", 0)),
                        float(b.get("y1", 0)),
                    )
                except Exception:
                    continue
                existing_by_rect[rk] = b

            match_entries: list[tuple[str, int, float, float, float, float]] = []
            selection_tokens: list[tuple[str, list[str]]] = []
            seen_keys: set[str] = set()
            for key_text, sel_rect in selections:
                key_text = str(key_text or "").strip()
                if not key_text or key_text in seen_keys:
                    continue
                toks = [t for t in key_text.split() if t]
                if not toks:
                    continue
                seen_keys.add(key_text)
                selection_tokens.append((key_text, toks))
                match_entries.append(
                    (
                        key_text,
                        int(parsed.page),
                        float(sel_rect.x0),
                        float(sel_rect.y0),
                        float(sel_rect.x1),
                        float(sel_rect.y1),
                    )
                )

            try:
                doc = fitz.open(record.detected_path)
            except Exception:
                doc = None
            if doc is not None:
                try:
                    if selection_tokens:
                        for page_num in range(doc.page_count):
                            if len(match_entries) >= max_matches:
                                break
                            page = doc.load_page(page_num)
                            words = page.get_text("words") or []

                            by_line: dict[
                                tuple[int, int], list[tuple[int | None, float, float, float, float, str]]
                            ] = {}
                            for w in words:
                                try:
                                    x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4]
                                    block_no = int(w[5]) if len(w) > 5 else 0
                                    line_no = int(w[6]) if len(w) > 6 else 0
                                    word_no = int(w[7]) if len(w) > 7 else None
                                except Exception:
                                    continue
                                normalized = list_manager.normalize(str(text))
                                if not normalized:
                                    continue
                                by_line.setdefault((block_no, line_no), []).append(
                                    (word_no, float(x0), float(y0), float(x1), float(y1), normalized)
                                )

                            for _line_key in sorted(by_line.keys()):
                                entries = by_line[_line_key]
                                if len(match_entries) >= max_matches:
                                    break
                                entries.sort(
                                    key=lambda t: (t[0] is None, t[0] if t[0] is not None else 0, t[1])
                                )
                                norms = [e[5] for e in entries]
                                if not norms:
                                    continue

                                for match_key, toks in selection_tokens:
                                    if len(match_entries) >= max_matches:
                                        break
                                    target_len = len(toks)
                                    if target_len == 1:
                                        token = toks[0]
                                        for e in entries:
                                            if e[5] != token:
                                                continue
                                            match_entries.append((match_key, int(page_num), e[1], e[2], e[3], e[4]))
                                            if len(match_entries) >= max_matches:
                                                break
                                        continue

                                    if len(norms) < target_len:
                                        continue
                                    for i in range(0, len(norms) - target_len + 1):
                                        if norms[i : i + target_len] != toks:
                                            continue
                                        span = entries[i : i + target_len]
                                        rx0 = min(e[1] for e in span)
                                        ry0 = min(e[2] for e in span)
                                        rx1 = max(e[3] for e in span)
                                        ry1 = max(e[4] for e in span)
                                        match_entries.append((match_key, int(page_num), rx0, ry0, rx1, ry1))
                                        if len(match_entries) >= max_matches:
                                            break
                finally:
                    doc.close()

            if not match_entries:
                action = {"type": "ADD_MANUAL_BOX", "box": box_payload}
                return _apply_one(action, record_history=record_history)

            prior_states: list[dict] = []
            desired_states: list[dict] = []
            seen_rects: set[tuple[str, tuple]] = set()

            for match_key, page_num, x0, y0, x1, y1 in match_entries:
                rk = _rect_key(page_num, x0, y0, x1, y1)
                sk = (str(match_key), rk)
                if sk in seen_rects:
                    continue
                seen_rects.add(sk)

                existing = existing_by_rect.get(rk)
                if existing is not None:
                    box_id = existing.get("box_id") or f"manual_{uuid4().hex[:12]}"
                    existing.setdefault("box_id", box_id)
                    prior_states.append({"box_id": box_id, "is_removed": bool(existing.get("is_removed"))})
                    existing.update(
                        {
                            "page": int(page_num),
                            "x0": float(x0),
                            "y0": float(y0),
                            "x1": float(x1),
                            "y1": float(y1),
                            "entity_type": "MANUAL",
                            "confidence": 1.0,
                            "is_auto": False,
                            "manual_match_key": str(match_key),
                        }
                    )
                    if overlay_text is not None:
                        existing["overlay_text"] = overlay_text
                    existing["is_removed"] = False
                    desired_states.append({"box_id": box_id, "is_removed": False})
                    continue

                box_id = f"manual_{uuid4().hex[:12]}"
                prior_states.append({"box_id": box_id, "is_removed": True})
                manual.append(
                    {
                        "box_id": box_id,
                        "page": int(page_num),
                        "x0": float(x0),
                        "y0": float(y0),
                        "x1": float(x1),
                        "y1": float(y1),
                        "entity_type": "MANUAL",
                        "confidence": 1.0,
                        "is_auto": False,
                        "is_removed": False,
                        "overlay_text": overlay_text,
                        "manual_match_key": str(match_key),
                    }
                )
                desired_states.append({"box_id": box_id, "is_removed": False})

            inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": prior_states}}
            action = {"type": "BULK_SET_REMOVED", "updates": {"states": desired_states}}
        elif action_type == "ADD_MANUAL_BOX":
            # Extract lines within the drawn rectangle (single-area line extraction)
            box_payload = action.get("box") or {}
            try:
                parsed = RedactionBox(**box_payload)
            except Exception as exc:
                raise HTTPException(400, f"Invalid manual box payload: {exc}") from exc

            overlay_text = parsed.overlay_text or "REDACTED"
            added_ids: list[str] = []

            # Try to extract individual lines within the drawn rectangle
            lines_extracted: list[tuple[str, fitz.Rect]] = []
            if record.detected_path:
                try:
                    doc = fitz.open(record.detected_path)
                    page = doc.load_page(parsed.page)
                    rect = fitz.Rect(parsed.x0, parsed.y0, parsed.x1, parsed.y1)
                    lines_extracted = _extract_lines_for_bulk(page, rect)
                    doc.close()
                except Exception:
                    lines_extracted = []

            if lines_extracted:
                # Create a box for each extracted line
                for key_text, line_rect in lines_extracted:
                    new_id = f"manual_{uuid4().hex[:12]}"
                    new_box = {
                        "page": parsed.page,
                        "x0": float(line_rect.x0),
                        "y0": float(line_rect.y0),
                        "x1": float(line_rect.x1),
                        "y1": float(line_rect.y1),
                        "entity_type": parsed.entity_type or "MANUAL",
                        "confidence": parsed.confidence or 1.0,
                        "overlay_text": overlay_text,
                        "box_id": new_id,
                        "is_auto": False,
                        "is_removed": False,
                        "manual_match_key": key_text,
                    }
                    manual.append(new_box)
                    added_ids.append(new_id)
            else:
                # Fallback: no lines found, create single box at drawn coordinates
                new_id = parsed.box_id or f"manual_{uuid4().hex[:12]}"
                manual_match_key = ""
                if record.detected_path:
                    try:
                        doc = fitz.open(record.detected_path)
                        page = doc.load_page(parsed.page)
                        rect = fitz.Rect(parsed.x0, parsed.y0, parsed.x1, parsed.y1)
                        manual_match_key = _extract_manual_match_key_for_rect(page, rect)
                        doc.close()
                    except Exception:
                        manual_match_key = ""
                existing = _find_box(new_id)
                if existing:
                    _kind, _idx, b = existing
                    b.update(parsed.model_dump(exclude_none=True))
                    b["box_id"] = new_id
                    b["is_auto"] = False
                    b["is_removed"] = False
                    b["manual_match_key"] = manual_match_key
                else:
                    manual.append(
                        {
                            **parsed.model_dump(exclude_none=True),
                            "box_id": new_id,
                            "is_auto": False,
                            "is_removed": False,
                            "manual_match_key": manual_match_key,
                        }
                    )
                added_ids.append(new_id)

            # Inverse: remove all added boxes
            if len(added_ids) == 1:
                inverse = {"type": "REMOVE_MANUAL_BOX", "box_id": added_ids[0]}
                action = {"type": "ADD_MANUAL_BOX", "box": {**parsed.model_dump(exclude_none=True), "box_id": added_ids[0]}}
            else:
                inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": [{"box_id": bid, "is_removed": True} for bid in added_ids]}}
                action = {"type": "BULK_ADD_MANUAL_BOXES", "box_ids": added_ids}
        elif action_type == "REMOVE_MANUAL_BOX":
            target_id = action.get("box_id")
            if not target_id:
                raise HTTPException(400, "REMOVE_MANUAL_BOX requires box_id")
            found = _find_box(target_id)
            if not found or found[0] != "manual":
                raise HTTPException(400, f"Unknown manual box_id: {target_id}")
            before = bool(found[2].get("is_removed"))
            found[2]["is_removed"] = True
            inverse = {"type": "REMOVE_MANUAL_BOX" if before else "RESTORE_MANUAL_BOX", "box_id": target_id}
        elif action_type == "RESTORE_MANUAL_BOX":
            target_id = action.get("box_id")
            if not target_id:
                raise HTTPException(400, "RESTORE_MANUAL_BOX requires box_id")
            found = _find_box(target_id)
            if not found or found[0] != "manual":
                raise HTTPException(400, f"Unknown manual box_id: {target_id}")
            before = bool(found[2].get("is_removed"))
            found[2]["is_removed"] = False
            inverse = {"type": "REMOVE_MANUAL_BOX" if before else "RESTORE_MANUAL_BOX", "box_id": target_id}
        elif action_type == "UPDATE_MANUAL_BOX":
            target_id = action.get("box_id")
            updates = action.get("updates") or {}
            if not target_id:
                raise HTTPException(400, "UPDATE_MANUAL_BOX requires box_id")
            found = _find_box(target_id)
            if not found or found[0] != "manual":
                raise HTTPException(400, f"Unknown manual box_id: {target_id}")
            before_state = {k: found[2].get(k) for k in ["page", "x0", "y0", "x1", "y1", "overlay_text"]}
            for key in ["page", "x0", "y0", "x1", "y1", "overlay_text"]:
                if key in updates and updates[key] is not None:
                    found[2][key] = updates[key]
            inverse = {"type": "UPDATE_MANUAL_BOX", "box_id": target_id, "updates": before_state}
        elif action_type == "ADD_KEEP_BOX":
            box_payload = action.get("box") or {}
            try:
                parsed = KeepBox(**box_payload)
            except Exception as exc:
                raise HTTPException(400, f"Invalid keep box payload: {exc}") from exc

            new_id = parsed.box_id or f"keep_{uuid4().hex[:12]}"
            existing = _find_keep_box(new_id)
            if existing:
                _idx, b = existing
                b.update(parsed.model_dump(exclude_none=True))
                b["box_id"] = new_id
                b["is_removed"] = False
            else:
                keep.append(
                    {
                        **parsed.model_dump(exclude_none=True),
                        "box_id": new_id,
                        "is_removed": False,
                    }
                )
            # Keep-box actions are intentionally NOT recorded in undo/redo history yet.
            should_record_history = False
        elif action_type in {"BULK_REMOVE_SIMILAR", "BULK_RESTORE_SIMILAR"}:
            target_id = action.get("box_id")
            if not target_id:
                raise HTTPException(400, f"{action_type} requires box_id")
            found = _find_box(str(target_id))
            if not found:
                raise HTTPException(400, f"Unknown box_id: {target_id}")
            kind, _idx, b = found

            updates = action.get("updates") or {}
            scope = updates.get("scope") if isinstance(updates, dict) else None
            scope_page: int | None = None
            scope_keep_only = False
            if isinstance(scope, dict):
                if scope.get("page") is not None:
                    try:
                        scope_page = int(scope.get("page"))
                    except Exception:
                        scope_page = None
                scope_keep_only = bool(scope.get("keep_only"))

            keeps_by_page: dict[int, list[dict]] = {}
            if scope_keep_only:
                for kb in keep:
                    if not isinstance(kb, dict):
                        continue
                    if kb.get("is_removed"):
                        continue
                    try:
                        kp = int(kb.get("page", 0))
                        kx0 = float(kb.get("x0", 0))
                        ky0 = float(kb.get("y0", 0))
                        kx1 = float(kb.get("x1", 0))
                        ky1 = float(kb.get("y1", 0))
                    except Exception:
                        continue
                    keeps_by_page.setdefault(kp, []).append(
                        {
                            "x0": min(kx0, kx1),
                            "y0": min(ky0, ky1),
                            "x1": max(kx0, kx1),
                            "y1": max(ky0, ky1),
                        }
                    )

            def _in_keep_scope(box_dict: dict) -> bool:
                if not scope_keep_only:
                    return True
                try:
                    bp = int(box_dict.get("page", 0))
                    bx0 = float(box_dict.get("x0", 0))
                    by0 = float(box_dict.get("y0", 0))
                    bx1 = float(box_dict.get("x1", 0))
                    by1 = float(box_dict.get("y1", 0))
                except Exception:
                    return False
                page_keeps = keeps_by_page.get(bp) or []
                if not page_keeps:
                    # No keep boxes on this page -> no crop constraint.
                    return True
                rx0 = min(bx0, bx1)
                ry0 = min(by0, by1)
                rx1 = max(bx0, bx1)
                ry1 = max(by0, by1)
                for krect in page_keeps:
                    ix0 = max(rx0, float(krect["x0"]))
                    iy0 = max(ry0, float(krect["y0"]))
                    ix1 = min(rx1, float(krect["x1"]))
                    iy1 = min(ry1, float(krect["y1"]))
                    if ix1 > ix0 and iy1 > iy0:
                        return True
                return False

            if kind == "auto":
                key = _ai_match_key(b)
                group = [bx for bx in boxes if _ai_match_key(bx) == key] if key else [b]
            else:
                # Manual boxes use an internal key derived from the extracted text inside the rect.
                if b.get("manual_match_key") is None:
                    b["manual_match_key"] = None
                _ensure_manual_match_keys()
                key = str(b.get("manual_match_key") or "")
                group = [bx for bx in manual if str(bx.get("manual_match_key") or "") == key] if key else [b]

            if scope_page is not None:
                group = [bx for bx in group if int(bx.get("page", -1)) == scope_page]
            if scope_keep_only:
                group = [bx for bx in group if isinstance(bx, dict) and _in_keep_scope(bx)]

            if not group:
                return None

            wants_removed = action_type == "BULK_REMOVE_SIMILAR"
            prior_states = [{"box_id": bx.get("box_id"), "is_removed": bool(bx.get("is_removed"))} for bx in group]
            desired_states = [{"box_id": bx.get("box_id"), "is_removed": wants_removed} for bx in group]
            for bx in group:
                bx["is_removed"] = wants_removed
            inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": prior_states}}
            # Store a deterministic redo action (exact box_ids), not a fuzzy match.
            action = {"type": "BULK_SET_REMOVED", "updates": {"states": desired_states}}
        elif action_type == "BULK_SET_REMOVED":
            updates = action.get("updates") or {}
            states = updates.get("states") or []
            if not isinstance(states, list):
                raise HTTPException(400, "BULK_SET_REMOVED updates.states must be a list")

            inverse_states: list[dict] = []
            for s in states:
                if not isinstance(s, dict):
                    continue
                box_id = s.get("box_id")
                if not box_id:
                    continue
                found = _find_box(str(box_id))
                if not found:
                    continue
                _kind, _idx, bb = found
                inverse_states.append({"box_id": bb.get("box_id"), "is_removed": bool(bb.get("is_removed"))})
                bb["is_removed"] = bool(s.get("is_removed"))

            inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": inverse_states}}
        elif action_type == "REVERT_WHITELIST_ADDITION":
            term = action.get("term")
            if not term:
                raise HTTPException(400, "REVERT_WHITELIST_ADDITION requires term")
            normalized = list_manager.normalize(str(term))
            if not normalized:
                return None

            group = []
            for bx in boxes:
                if not bx.get("is_removed"):
                    continue
                raw = bx.get("text")
                if not raw or not str(raw).strip():
                    continue
                if list_manager.normalize(str(raw)) == normalized:
                    bx.setdefault("box_id", f"ai_{uuid4().hex[:12]}")
                    group.append(bx)

            if not group:
                return None

            prior_states = [{"box_id": bx.get("box_id"), "is_removed": bool(bx.get("is_removed"))} for bx in group]
            desired_states = [{"box_id": bx.get("box_id"), "is_removed": False} for bx in group]
            for bx in group:
                bx["is_removed"] = False
            inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": prior_states}}
            action = {"type": "BULK_SET_REMOVED", "updates": {"states": desired_states}}
        elif action_type == "REVERT_BLACKLIST_ADDITION":
            term = action.get("term")
            if not term:
                raise HTTPException(400, "REVERT_BLACKLIST_ADDITION requires term")
            normalized = list_manager.normalize(str(term))
            if not normalized:
                return None

            group: list[dict] = []
            if record.detected_path:
                try:
                    doc = fitz.open(record.detected_path)
                except Exception:
                    doc = None
                if doc is not None:
                    try:
                        for b in manual:
                            if b.get("is_removed"):
                                continue
                            b.setdefault("box_id", f"manual_{uuid4().hex[:12]}")
                            key = list_manager.normalize(str(b.get("manual_match_key") or ""))
                            if key and key == normalized:
                                group.append(b)
                                continue
                            try:
                                page = doc.load_page(int(b.get("page", 0)))
                                rect = fitz.Rect(float(b["x0"]), float(b["y0"]), float(b["x1"]), float(b["y1"]))
                                text = _extract_text_for_learning(page, rect)
                            except Exception:
                                text = None
                            if not text or not str(text).strip():
                                continue
                            learned = set(_extract_blacklist_phrases_from_box_text(str(text)))
                            if normalized in learned:
                                group.append(b)
                    finally:
                        doc.close()
            else:
                for b in manual:
                    if b.get("is_removed"):
                        continue
                    b.setdefault("box_id", f"manual_{uuid4().hex[:12]}")
                    key = list_manager.normalize(str(b.get("manual_match_key") or ""))
                    if key and key == normalized:
                        group.append(b)

            if not group:
                return None

            prior_states = [{"box_id": bx.get("box_id"), "is_removed": bool(bx.get("is_removed"))} for bx in group]
            desired_states = [{"box_id": bx.get("box_id"), "is_removed": True} for bx in group]
            for bx in group:
                bx["is_removed"] = True
            inverse = {"type": "BULK_SET_REMOVED", "updates": {"states": prior_states}}
            action = {"type": "BULK_SET_REMOVED", "updates": {"states": desired_states}}
        else:
            raise HTTPException(400, f"Unsupported action type: {action_type}")

        if should_record_history:
            record.history_past.append({"action": action, "inverse": inverse})
            record.history_future = []
        return inverse

    for action in request.actions:
        _apply_one(action.model_dump(exclude_none=True))

    record.redaction_boxes = boxes
    record.manual_boxes = manual
    record.keep_boxes = keep

    stats = record.stats or {}
    total_pages = int(stats.get("total_pages") or 0)
    if total_pages <= 0 and record.detected_path:
        try:
            doc = fitz.open(record.detected_path)
            total_pages = doc.page_count
            doc.close()
        except Exception:
            total_pages = 0

    redaction_boxes = [RedactionBox(**sanitize_box_payload(box)) for box in boxes]
    manual_boxes = [RedactionBox(**sanitize_box_payload(box)) for box in manual]
    keep_boxes = [KeepBox(**sanitize_box_payload(box)) for box in keep]
    whitelist_additions, blacklist_additions = _compute_pdf_learning_terms(record)

    return RedactionResponse(
        document_id=document_id,
        total_pages=total_pages,
        redaction_boxes=redaction_boxes,
        manual_boxes=manual_boxes,
        keep_boxes=keep_boxes,
        page_previews={},
        stats=stats,
        payload_type="pdf",
        can_undo=bool(record.history_past),
        can_redo=bool(record.history_future),
        whitelist_additions=whitelist_additions,
        blacklist_additions=blacklist_additions,
    )
