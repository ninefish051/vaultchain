// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title CardPriceOracle
/// @notice Stores the aggregated fair value and volatility of each card type (CardKey).
///         Prices are computed off-chain from eBay / PriceCharting / other sources, signed with
///         EIP-712 by an authorised signer, and can be relayed on-chain by anyone.
contract CardPriceOracle is AccessControl, EIP712 {
    bytes32 public constant ORACLE_SIGNER_ROLE = keccak256("ORACLE_SIGNER_ROLE");

    struct PricePoint {
        uint128 fairValueUsd; // 6 decimals, same unit as USDC
        uint32 volatilityBps; // 30-day volatility in basis points
        uint16 sampleCount;
        uint8 confidence; // 0-100
        uint64 updatedAt; // observation timestamp (seconds)
        bytes32 evidenceHash; // hash of the raw sample snapshot (IPFS CID hash)
    }

    bytes32 public constant PRICE_TYPEHASH = keccak256(
        "PricePoint(bytes32 cardKey,uint128 fairValueUsd,uint32 volatilityBps,uint16 sampleCount,uint8 confidence,uint64 updatedAt,bytes32 evidenceHash)"
    );

    /// @notice Largest move allowed in one signed update (bps). Bigger moves need an admin override.
    uint256 public maxDeviationBps = 3000;
    /// @notice Signed observations may not be dated further than this into the future.
    uint256 public constant MAX_FUTURE_DRIFT = 5 minutes;

    mapping(bytes32 cardKey => PricePoint) private _prices;

    event PriceUpdated(
        bytes32 indexed cardKey,
        uint128 fairValueUsd,
        uint32 volatilityBps,
        uint8 confidence,
        uint64 updatedAt,
        bytes32 evidenceHash,
        address signer
    );
    event MaxDeviationUpdated(uint256 bps);

    error InvalidSigner(address recovered);
    error StaleUpdate(uint64 current, uint64 incoming);
    error FutureTimestamp(uint64 updatedAt);
    error DeviationTooLarge(uint128 previous, uint128 incoming);
    error ZeroPrice();
    error PriceUnavailable(bytes32 cardKey);
    error PriceTooOld(bytes32 cardKey, uint64 updatedAt);

    constructor(address admin) EIP712("VaultChain CardPriceOracle", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ writes

    /// @notice Submit a price signed by an ORACLE_SIGNER_ROLE key. Anyone may relay it.
    function submitPrice(bytes32 cardKey, PricePoint calldata p, bytes calldata signature) external {
        address signer = ECDSA.recover(_hashTypedDataV4(_structHash(cardKey, p)), signature);
        if (!hasRole(ORACLE_SIGNER_ROLE, signer)) revert InvalidSigner(signer);

        PricePoint storage cur = _prices[cardKey];
        if (cur.updatedAt != 0 && _deviationBps(cur.fairValueUsd, p.fairValueUsd) > maxDeviationBps) {
            revert DeviationTooLarge(cur.fairValueUsd, p.fairValueUsd);
        }
        _store(cardKey, p, signer);
    }

    /// @notice Admin (multisig) override for moves larger than maxDeviationBps or manual corrections.
    function forceSetPrice(bytes32 cardKey, PricePoint calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _store(cardKey, p, msg.sender);
    }

    function setMaxDeviationBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxDeviationBps = bps;
        emit MaxDeviationUpdated(bps);
    }

    // ------------------------------------------------------------------ reads

    function getPrice(bytes32 cardKey) external view returns (PricePoint memory) {
        return _prices[cardKey];
    }

    /// @notice Returns the price, reverting if missing or older than maxAge.
    function getFreshPrice(bytes32 cardKey, uint256 maxAge) external view returns (PricePoint memory p) {
        p = _prices[cardKey];
        if (p.updatedAt == 0) revert PriceUnavailable(cardKey);
        if (block.timestamp > p.updatedAt + maxAge) revert PriceTooOld(cardKey, p.updatedAt);
    }

    /// @notice Non-reverting read used for settlement: returns ok=false if missing or stale.
    function tryGetFreshPrice(bytes32 cardKey, uint256 maxAge) external view returns (bool ok, uint128 fairValueUsd) {
        PricePoint storage p = _prices[cardKey];
        if (p.updatedAt == 0 || block.timestamp > p.updatedAt + maxAge) return (false, 0);
        return (true, p.fairValueUsd);
    }

    function hashPricePoint(bytes32 cardKey, PricePoint calldata p) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(cardKey, p));
    }

    // ------------------------------------------------------------------ internal

    function _store(bytes32 cardKey, PricePoint calldata p, address signer) private {
        if (p.fairValueUsd == 0) revert ZeroPrice();
        PricePoint storage cur = _prices[cardKey];
        if (p.updatedAt <= cur.updatedAt) revert StaleUpdate(cur.updatedAt, p.updatedAt);
        if (p.updatedAt > block.timestamp + MAX_FUTURE_DRIFT) revert FutureTimestamp(p.updatedAt);
        _prices[cardKey] = p;
        emit PriceUpdated(cardKey, p.fairValueUsd, p.volatilityBps, p.confidence, p.updatedAt, p.evidenceHash, signer);
    }

    function _structHash(bytes32 cardKey, PricePoint calldata p) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PRICE_TYPEHASH,
                cardKey,
                p.fairValueUsd,
                p.volatilityBps,
                p.sampleCount,
                p.confidence,
                p.updatedAt,
                p.evidenceHash
            )
        );
    }

    function _deviationBps(uint128 a, uint128 b) private pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / a;
    }
}
