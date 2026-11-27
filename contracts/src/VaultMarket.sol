// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {VaultCardNFT} from "./VaultCardNFT.sol";

/// @title VaultMarket
/// @notice Spot market for cards that are already vaulted. The NFT and the USDC payment are
///         swapped atomically in one transaction, so no deposits or inspection are needed.
///         Listings are non-custodial: the seller keeps the NFT and approves this contract.
contract VaultMarket is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    VaultCardNFT public immutable nft;
    address public treasury;
    uint16 public feeBps; // platform fee on each sale
    uint16 public constant MAX_FEE_BPS = 1000;

    struct Listing {
        address seller;
        uint128 priceUsd; // 6 decimals
    }

    mapping(uint256 tokenId => Listing) public listings;

    event Listed(uint256 indexed tokenId, address indexed seller, uint128 priceUsd);
    event Unlisted(uint256 indexed tokenId);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint128 priceUsd, uint256 fee);
    event FeeUpdated(address treasury, uint16 feeBps);

    error NotOwner();
    error NotListed();
    error StaleListing();
    error PriceMismatch(uint128 listed, uint128 expected);
    error FeeTooHigh();
    error ZeroPrice();

    constructor(address admin, IERC20 usdc_, VaultCardNFT nft_, address treasury_, uint16 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        nft = nft_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function list(uint256 tokenId, uint128 priceUsd) external {
        if (nft.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (priceUsd == 0) revert ZeroPrice();
        listings[tokenId] = Listing(msg.sender, priceUsd);
        emit Listed(tokenId, msg.sender, priceUsd);
    }

    function unlist(uint256 tokenId) external {
        if (listings[tokenId].seller != msg.sender) revert NotOwner();
        delete listings[tokenId];
        emit Unlisted(tokenId);
    }

    /// @notice Buy with a prior USDC approval. `expectedPrice` protects against a price change
    ///         between the buyer seeing the listing and the transaction landing.
    function buy(uint256 tokenId, uint128 expectedPrice) external nonReentrant {
        Listing memory l = _checkListing(tokenId, expectedPrice);
        usdc.safeTransferFrom(msg.sender, address(this), l.priceUsd);
        _settle(tokenId, l, msg.sender);
    }

    /// @notice Buy with an EIP-3009 authorization signed by the buyer (gasless approval).
    function buyWithAuthorization(
        uint256 tokenId,
        uint128 expectedPrice,
        address buyer,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        Listing memory l = _checkListing(tokenId, expectedPrice);
        IERC3009(address(usdc)).receiveWithAuthorization(
            buyer, address(this), l.priceUsd, validAfter, validBefore, nonce, v, r, s
        );
        _settle(tokenId, l, buyer);
    }

    function setFee(address treasury_, uint16 feeBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
        emit FeeUpdated(treasury_, feeBps_);
    }

    function _checkListing(uint256 tokenId, uint128 expectedPrice) private view returns (Listing memory l) {
        l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (l.priceUsd != expectedPrice) revert PriceMismatch(l.priceUsd, expectedPrice);
        // Listing is void if the NFT changed hands or got locked for redemption.
        if (nft.ownerOf(tokenId) != l.seller) revert StaleListing();
        if (nft.custodyOf(tokenId) != VaultCardNFT.Custody.InVault) revert StaleListing();
    }

    function _settle(uint256 tokenId, Listing memory l, address buyer) private {
        delete listings[tokenId];
        uint256 fee = (uint256(l.priceUsd) * feeBps) / 10_000;
        nft.safeTransferFrom(l.seller, buyer, tokenId);
        usdc.safeTransfer(l.seller, l.priceUsd - fee);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        emit Sold(tokenId, l.seller, buyer, l.priceUsd, fee);
    }
}
