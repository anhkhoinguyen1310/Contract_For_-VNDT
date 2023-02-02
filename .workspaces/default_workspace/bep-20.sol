pragma solidity ^0.8.0;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/ERC20.sol";

contract VNDONG  is ERC20 {
    constructor(uint256 initalSupply) public ERC20 ("VNDONG", "VNDT"){
        _mint(msg.sender, initalSupply);

    } 
}