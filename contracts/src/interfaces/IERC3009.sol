// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice EIP-3009 subset implemented by USDC. `receiveWithAuthorization` requires
///         msg.sender == to, which prevents front-running of the authorization.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
