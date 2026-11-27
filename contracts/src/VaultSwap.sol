// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VaultCardNFT} from "./VaultCardNFT.sol";

/// @title VaultSwap
/// @notice Card-for-card swap of graded slabs that are already in the vault (NFT <-> NFT), in one
///         atomic transaction, optionally with a USDC top-up for the value difference.
///
///         A maker offers one NFT and asks for either a specific token or any token of a card type
///         (`cardKey`, which includes grader and grade, e.g. "any PSA 10 Base Set Charizard").
///         Offers are non-custodial: the maker keeps the NFT until someone accepts.
///         Each side pays a flat `feeUsd` to the treasury.
contract VaultSwap is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Offer {
        address maker;
        uint256 giveTokenId;
        uint256 wantTokenId; // non-zero: only this token
        bytes32 wantCardKey; // used when wantTokenId == 0: any token of this card type
        uint128 topUpUsd; // USDC paid on top of the card, 6 decimals
        bool makerPaysTopUp; // true: maker pays the taker; false: taker pays the maker
        uint64 expiry;
    }

    uint128 public constant MAX_FEE_USD = 50e6;

    IERC20 public immutable usdc;
    VaultCardNFT public immutable nft;
    address public treasury;
    uint128 public feeUsd; // per side

    uint256 public nextOfferId = 1;
    mapping(uint256 offerId => Offer) public offers;

    event OfferCreated(
        uint256 indexed offerId,
        address indexed maker,
        uint256 indexed giveTokenId,
        uint256 wantTokenId,
        bytes32 wantCardKey,
        uint128 topUpUsd,
        bool makerPaysTopUp,
        uint64 expiry
    );
    event OfferCancelled(uint256 indexed offerId);
    event Swapped(
        uint256 indexed offerId,
        address indexed maker,
        address indexed taker,
        uint256 makerTokenId,
        uint256 takerTokenId,
        uint128 topUpUsd,
        bool makerPaysTopUp
    );
    event FeeUpdated(address treasury, uint128 feeUsd);

    error NotOwner();
    error NotInVault();
    error BadOffer();
    error OfferNotFound();
    error OfferExpired();
    error StaleOffer();
    error NotWanted();
    error FeeTooHigh();

    constructor(address admin, IERC20 usdc_, VaultCardNFT nft_, address treasury_, uint128 feeUsd_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        nft = nft_;
        _setFee(treasury_, feeUsd_);
    }

    function createOffer(
        uint256 giveTokenId,
        uint256 wantTokenId,
        bytes32 wantCardKey,
        uint128 topUpUsd,
        bool makerPaysTopUp,
        uint64 expiry
    ) external returns (uint256 offerId) {
        if (nft.ownerOf(giveTokenId) != msg.sender) revert NotOwner();
        if (nft.custodyOf(giveTokenId) != VaultCardNFT.Custody.InVault) revert NotInVault();
        bool specific = wantTokenId != 0;
        if (specific == (wantCardKey != bytes32(0))) revert BadOffer(); // exactly one target
        if (wantTokenId == giveTokenId || expiry <= block.timestamp) revert BadOffer();
        if (topUpUsd == 0) makerPaysTopUp = false;

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            maker: msg.sender,
            giveTokenId: giveTokenId,
            wantTokenId: wantTokenId,
            wantCardKey: wantCardKey,
            topUpUsd: topUpUsd,
            makerPaysTopUp: makerPaysTopUp,
            expiry: expiry
        });
        emit OfferCreated(
            offerId, msg.sender, giveTokenId, wantTokenId, wantCardKey, topUpUsd, makerPaysTopUp, expiry
        );
    }

    function cancelOffer(uint256 offerId) external {
        if (offers[offerId].maker != msg.sender) revert NotOwner();
        delete offers[offerId];
        emit OfferCancelled(offerId);
    }

    /// @notice Accept an offer with `takerTokenId`. Both NFTs and the top-up move in this call.
    /// @dev    Both sides must have approved this contract for the NFT (setApprovalForAll) and USDC.
    function acceptOffer(uint256 offerId, uint256 takerTokenId) external nonReentrant {
        Offer memory o = offers[offerId];
        if (o.maker == address(0)) revert OfferNotFound();
        if (block.timestamp > o.expiry) revert OfferExpired();
        if (o.maker == msg.sender) revert BadOffer();
        if (nft.ownerOf(o.giveTokenId) != o.maker || nft.custodyOf(o.giveTokenId) != VaultCardNFT.Custody.InVault)
        {
            revert StaleOffer();
        }
        if (nft.ownerOf(takerTokenId) != msg.sender) revert NotOwner();
        if (nft.custodyOf(takerTokenId) != VaultCardNFT.Custody.InVault) revert NotInVault();
        if (o.wantTokenId != 0) {
            if (takerTokenId != o.wantTokenId) revert NotWanted();
        } else if (nft.slabOf(takerTokenId).cardKey != o.wantCardKey) {
            revert NotWanted();
        }

        delete offers[offerId];

        nft.transferFrom(o.maker, msg.sender, o.giveTokenId);
        nft.transferFrom(msg.sender, o.maker, takerTokenId);
        if (o.topUpUsd > 0) {
            (address payer, address payee) = o.makerPaysTopUp ? (o.maker, msg.sender) : (msg.sender, o.maker);
            usdc.safeTransferFrom(payer, payee, o.topUpUsd);
        }
        uint128 fee = feeUsd;
        if (fee > 0) {
            usdc.safeTransferFrom(o.maker, treasury, fee);
            usdc.safeTransferFrom(msg.sender, treasury, fee);
        }
        emit Swapped(offerId, o.maker, msg.sender, o.giveTokenId, takerTokenId, o.topUpUsd, o.makerPaysTopUp);
    }

    function setFee(address treasury_, uint128 feeUsd_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFee(treasury_, feeUsd_);
    }

    function _setFee(address treasury_, uint128 feeUsd_) private {
        if (feeUsd_ > MAX_FEE_USD || treasury_ == address(0)) revert FeeTooHigh();
        treasury = treasury_;
        feeUsd = feeUsd_;
        emit FeeUpdated(treasury_, feeUsd_);
    }
}
