// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {CardPriceOracle} from "./CardPriceOracle.sol";
import {VaultCardNFT} from "./VaultCardNFT.sol";

/// @title SwapEscrow
/// @notice Escrowed card-for-card swap of graded slabs (e.g. PSA 10 <-> PSA 10) where at least one
///         card is still physical. Both parties sign the terms (EIP-712), both lock a deposit sized
///         from the volatility of the two cards, physical cards are shipped to the vault and
///         inspected, then each side receives the other card (as a vault NFT or shipped out).
///
///         Each leg is either:
///           - Physical: the owner ships it to the vault; the vault inspects it.
///           - Vaulted:  already a VaultCardNFT; it is pulled into escrow when the owner funds.
///
///         An optional USDC top-up covers the value difference; the paying side locks it together
///         with its deposit. If one side does not ship, the other is compensated from the
///         defaulter's deposit: at least `minPenaltyBps`, or the move in the value spread between
///         the two cards since signing if larger (the gain the innocent side was denied).
///
///         Funding accepts approval, EIP-3009 and HSP Gateway transfers (relayer-attributed),
///         with the same unallocated-balance accounting as VaultEscrow. Payouts are pull-based.
contract SwapEscrow is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ roles

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Signed, // waiting for both deposits (and vaulted NFTs)
        Locked, // waiting for physical legs to be shipped to the vault
        Inspecting, // all physical legs at the vault
        Disputed, // an inspection failed or timed out
        AwaitingDelivery, // swapped; vault ships out the legs that go to an address
        Completed,
        Defaulted, // one side never shipped
        Cancelled, // never fully funded, or neither side shipped
        Refunded // dispute resolved, everything returned
    }

    enum Kind {
        Physical,
        Vaulted
    }

    enum Delivery {
        ShipToCounterparty,
        KeepInVault
    }

    enum LegState {
        Pending, // physical, not shipped yet
        Shipped, // physical, on its way / at the vault
        Passed // inspected OK, or vaulted NFT held in escrow
    }

    struct Leg {
        address owner;
        bytes32 cardKey; // card type incl. grader + grade, used for the oracle
        bytes32 slabId; // keccak256(grader, certNumber); Vaulted => tokenId = uint256(slabId)
        bytes32 metadataHash; // used when minting a physical leg into the vault
        uint8 kind; // Kind
        uint8 delivery; // Delivery: how the counterparty receives this card
    }

    struct SwapTerms {
        Leg a;
        Leg b;
        uint128 topUpUsd; // 6 decimals
        uint8 topUpFrom; // 0 = none, 1 = a pays b, 2 = b pays a
        uint32 depositWindow;
        uint32 shipWindow;
        uint32 inspectWindow;
        uint256 nonce;
        uint64 signDeadline;
    }

    struct Swap {
        Leg[2] legs;
        LegState[2] legState;
        bool[2] funded;
        uint128[2] refValueUsd; // oracle fair value of each card at signing
        uint128 depositUsd; // per side
        uint128 topUpUsd;
        uint8 topUpFrom;
        uint32 shipWindow;
        uint32 inspectWindow;
        uint64 deadline;
        Status status;
    }

    struct Config {
        uint16 minDepositBps;
        uint16 maxDepositBps;
        uint32 volMultiplierBps;
        uint16 minPenaltyBps;
        uint16 feeBps; // charged to each side on the value of the card it receives
        uint16 maxValueDeviationBps; // max mismatch between what each side gives, 0 = disabled
        uint32 maxPriceAge;
    }

    bytes32 public constant LEG_TYPEHASH = keccak256(
        "Leg(address owner,bytes32 cardKey,bytes32 slabId,bytes32 metadataHash,uint8 kind,uint8 delivery)"
    );
    bytes32 public constant SWAP_TERMS_TYPEHASH = keccak256(
        "SwapTerms(Leg a,Leg b,uint128 topUpUsd,uint8 topUpFrom,uint32 depositWindow,uint32 shipWindow,uint32 inspectWindow,uint256 nonce,uint64 signDeadline)Leg(address owner,bytes32 cardKey,bytes32 slabId,bytes32 metadataHash,uint8 kind,uint8 delivery)"
    );

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdc;
    CardPriceOracle public immutable oracle;
    VaultCardNFT public immutable nft;
    address public treasury;
    Config public config;

    mapping(bytes32 swapId => Swap) private _swaps;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceUsed;
    mapping(bytes32 paymentRef => bool) public paymentRefUsed;
    mapping(address account => uint256) public credits;
    uint256 public totalHeld;

    // ------------------------------------------------------------------ events

    event SwapCreated(
        bytes32 indexed swapId,
        address indexed partyA,
        address indexed partyB,
        bytes32 slabA,
        bytes32 slabB,
        uint128 depositUsd,
        uint128 topUpUsd,
        uint8 topUpFrom
    );
    event StatusChanged(bytes32 indexed swapId, Status status, uint64 deadline);
    event Funded(bytes32 indexed swapId, address indexed payer, uint256 amount, uint8 source, bytes32 paymentRef);
    event LegShipped(bytes32 indexed swapId, uint8 side, bytes32 trackingHash);
    event LegInspected(bytes32 indexed swapId, uint8 side, bool passed, bytes32 reportHash);
    event LegReturned(bytes32 indexed swapId, uint8 side, bytes32 trackingHash);
    event DefaultSettled(bytes32 indexed swapId, address indexed defaulter, uint256 penalty);
    event DisputeResolved(bytes32 indexed swapId, uint8 atFault, uint256 award);
    event Credited(address indexed account, bytes32 indexed swapId, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event NonceCancelled(address indexed account, uint256 nonce);
    event ConfigUpdated(Config config, address treasury);

    // ------------------------------------------------------------------ errors

    error InvalidTerms();
    error SignatureExpired();
    error BadSignature(address signer);
    error NonceAlreadyUsed(address account, uint256 nonce);
    error SwapExists();
    error WrongStatus(Status current);
    error NotParty();
    error WrongLegState(LegState current);
    error NothingExpected();
    error DeadlinePassed();
    error DeadlineNotReached();
    error NftMismatch(uint8 side);
    error ValueMismatch(uint256 giveA, uint256 giveB);
    error InsufficientUnallocated(uint256 available, uint256 amount);
    error PaymentRefUsed();
    error AmountMismatch(uint256 expected, uint256 got);
    error AwardTooLarge();
    error NothingToWithdraw();
    error BadConfig();

    uint8 private constant SRC_TRANSFER = 0;
    uint8 private constant SRC_EIP3009 = 1;
    uint8 private constant SRC_HSP = 2;

    constructor(
        address admin,
        IERC20 usdc_,
        CardPriceOracle oracle_,
        VaultCardNFT nft_,
        address treasury_,
        Config memory config_
    ) EIP712("VaultChain SwapEscrow", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        oracle = oracle_;
        nft = nft_;
        _setConfig(config_, treasury_);
    }

    // ================================================================== 1. sign

    function createSwap(SwapTerms calldata t, bytes calldata sigA, bytes calldata sigB)
        external
        returns (bytes32 swapId)
    {
        _validateTerms(t);
        if (block.timestamp > t.signDeadline) revert SignatureExpired();

        swapId = hashSwapTerms(t);
        if (_swaps[swapId].status != Status.None) revert SwapExists();
        if (!SignatureChecker.isValidSignatureNow(t.a.owner, swapId, sigA)) revert BadSignature(t.a.owner);
        if (!SignatureChecker.isValidSignatureNow(t.b.owner, swapId, sigB)) revert BadSignature(t.b.owner);
        _useNonce(t.a.owner, t.nonce);
        _useNonce(t.b.owner, t.nonce);

        _checkVaulted(t.a, 0);
        _checkVaulted(t.b, 1);

        CardPriceOracle.PricePoint memory pa = oracle.getFreshPrice(t.a.cardKey, config.maxPriceAge);
        CardPriceOracle.PricePoint memory pb = oracle.getFreshPrice(t.b.cardKey, config.maxPriceAge);
        _checkValueBounds(pa.fairValueUsd, pb.fairValueUsd, t.topUpUsd, t.topUpFrom);

        uint256 base = pa.fairValueUsd > pb.fairValueUsd ? pa.fairValueUsd : pb.fairValueUsd;
        uint32 vol = pa.volatilityBps > pb.volatilityBps ? pa.volatilityBps : pb.volatilityBps;
        uint128 deposit = uint128(_ceilToCent((base * depositBpsFor(vol)) / 10_000)); // whole cents, see VaultEscrow

        Swap storage s = _swaps[swapId];
        s.legs[0] = t.a;
        s.legs[1] = t.b;
        s.refValueUsd[0] = pa.fairValueUsd;
        s.refValueUsd[1] = pb.fairValueUsd;
        s.depositUsd = deposit;
        s.topUpUsd = t.topUpUsd;
        s.topUpFrom = t.topUpFrom;
        s.shipWindow = t.shipWindow;
        s.inspectWindow = t.inspectWindow;

        emit SwapCreated(swapId, t.a.owner, t.b.owner, t.a.slabId, t.b.slabId, deposit, t.topUpUsd, t.topUpFrom);
        _transition(swapId, s, Status.Signed, t.depositWindow);
    }

    function cancelNonce(uint256 nonce) external {
        _useNonce(msg.sender, nonce);
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Not fully funded in time: return whatever arrived (USDC and escrowed NFTs).
    function cancelUnfunded(bytes32 swapId) external nonReentrant {
        Swap storage s = _requireStatus(swapId, Status.Signed);
        if (block.timestamp <= s.deadline) revert DeadlineNotReached();
        _refundAll(swapId, s);
        _transition(swapId, s, Status.Cancelled, 0);
    }

    // ================================================================== 2. fund

    /// @notice USDC `payer` must lock: deposit, plus the top-up if they are the paying side.
    function expectedPayment(bytes32 swapId, address payer) public view returns (uint256) {
        Swap storage s = _swaps[swapId];
        if (s.status != Status.Signed || block.timestamp > s.deadline) return 0;
        (bool isParty, uint8 side) = _sideOf(s, payer);
        if (!isParty || s.funded[side]) return 0;
        return _lockAmount(s, side);
    }

    function fund(bytes32 swapId) external nonReentrant {
        uint256 amount = _expectedOrRevert(swapId, msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _apply(swapId, msg.sender, amount, SRC_TRANSFER, bytes32(0));
    }

    function fundWithAuthorization(
        bytes32 swapId,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s_
    ) external nonReentrant {
        uint256 amount = _expectedOrRevert(swapId, payer);
        IERC3009(address(usdc)).receiveWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, nonce, v, r, s_
        );
        _apply(swapId, payer, amount, SRC_EIP3009, nonce);
    }

    /// @notice Attribute USDC the HSP Gateway already sent to this contract (pay_to = SwapEscrow).
    function recordHspPayment(bytes32 swapId, address payer, uint256 amount, bytes32 paymentRef)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
    {
        if (paymentRefUsed[paymentRef]) revert PaymentRefUsed();
        uint256 expected = _expectedOrRevert(swapId, payer);
        if (amount != expected) revert AmountMismatch(expected, amount);
        uint256 available = unallocatedBalance();
        if (available < amount) revert InsufficientUnallocated(available, amount);
        paymentRefUsed[paymentRef] = true;
        _apply(swapId, payer, amount, SRC_HSP, paymentRef);
    }

    // ================================================================== 3. ship + inspect

    function markShipped(bytes32 swapId, bytes32 trackingHash) external {
        Swap storage s = _requireStatus(swapId, Status.Locked);
        if (block.timestamp > s.deadline) revert DeadlinePassed();
        (bool isParty, uint8 side) = _sideOf(s, msg.sender);
        if (!isParty) revert NotParty();
        if (s.legState[side] != LegState.Pending) revert WrongLegState(s.legState[side]);
        s.legState[side] = LegState.Shipped;
        emit LegShipped(swapId, side, trackingHash);
        if (s.legState[1 - side] != LegState.Pending) _transition(swapId, s, Status.Inspecting, s.inspectWindow);
    }

    /// @notice Ship window over. One side missing => it defaults; both missing => cancel.
    function claimShipDefault(bytes32 swapId) external nonReentrant {
        Swap storage s = _requireStatus(swapId, Status.Locked);
        if (block.timestamp <= s.deadline) revert DeadlineNotReached();
        bool aMissing = s.legState[0] == LegState.Pending;
        bool bMissing = s.legState[1] == LegState.Pending;
        if (aMissing && bMissing) {
            _refundAll(swapId, s);
            _transition(swapId, s, Status.Cancelled, 0);
            return;
        }
        uint8 d = aMissing ? 0 : 1;
        uint8 i = 1 - d;
        uint256 penalty = _penalty(s, d);
        _credit(s.legs[i].owner, swapId, uint256(s.depositUsd) + penalty);
        _credit(s.legs[d].owner, swapId, s.depositUsd - penalty);
        _refundTopUp(swapId, s);
        _returnVaulted(s);
        emit DefaultSettled(swapId, s.legs[d].owner, penalty);
        _transition(swapId, s, Status.Defaulted, 0);
    }

    function submitInspection(bytes32 swapId, uint8 side, bool passed, bytes32 reportHash)
        external
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        Swap storage s = _requireStatus(swapId, Status.Inspecting);
        if (side > 1) revert InvalidTerms();
        if (s.legState[side] != LegState.Shipped) revert WrongLegState(s.legState[side]);
        emit LegInspected(swapId, side, passed, reportHash);
        if (!passed) {
            _transition(swapId, s, Status.Disputed, 0);
            return;
        }
        s.legState[side] = LegState.Passed;
        if (s.legState[1 - side] == LegState.Passed) _settle(swapId, s);
    }

    function escalateInspectionTimeout(bytes32 swapId) external {
        Swap storage s = _requireStatus(swapId, Status.Inspecting);
        if (block.timestamp <= s.deadline) revert DeadlineNotReached();
        _transition(swapId, s, Status.Disputed, 0);
    }

    /// @notice Arbiter unwinds the swap. `atFault` 0 = nobody, 1 = party A, 2 = party B; the party
    ///         at fault pays `award` (<= deposit) to the other. Top-up and vaulted NFTs go back;
    ///         physical cards are returned by the vault (see `recordReturn`).
    function resolveDispute(bytes32 swapId, uint8 atFault, uint256 award)
        external
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        Swap storage s = _requireStatus(swapId, Status.Disputed);
        if (atFault > 2 || (atFault == 0 && award != 0)) revert InvalidTerms();
        if (award > s.depositUsd) revert AwardTooLarge();
        uint256 depA = s.depositUsd;
        uint256 depB = s.depositUsd;
        if (atFault == 1) (depA, depB) = (depA - award, depB + award);
        if (atFault == 2) (depA, depB) = (depA + award, depB - award);
        _credit(s.legs[0].owner, swapId, depA);
        _credit(s.legs[1].owner, swapId, depB);
        _refundTopUp(swapId, s);
        _returnVaulted(s);
        emit DisputeResolved(swapId, atFault, award);
        _transition(swapId, s, Status.Refunded, 0);
    }

    /// @notice Vault logs the return shipment of a physical card after a default or dispute.
    function recordReturn(bytes32 swapId, uint8 side, bytes32 trackingHash) external onlyRole(VAULT_ROLE) {
        Status st = _swaps[swapId].status;
        if (st != Status.Defaulted && st != Status.Refunded) revert WrongStatus(st);
        emit LegReturned(swapId, side, trackingHash);
    }

    function confirmDelivered(bytes32 swapId) external onlyRole(VAULT_ROLE) {
        Swap storage s = _requireStatus(swapId, Status.AwaitingDelivery);
        _transition(swapId, s, Status.Completed, 0);
    }

    // ================================================================== withdrawals / admin

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        totalHeld -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function setConfig(Config calldata c, address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(c, treasury_);
    }

    function rescueUnallocated(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 available = unallocatedBalance();
        if (amount > available) revert InsufficientUnallocated(available, amount);
        usdc.safeTransfer(to, amount);
    }

    // ================================================================== views

    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return _swaps[swapId];
    }

    function hashSwapTerms(SwapTerms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SWAP_TERMS_TYPEHASH,
                    _hashLeg(t.a),
                    _hashLeg(t.b),
                    t.topUpUsd,
                    t.topUpFrom,
                    t.depositWindow,
                    t.shipWindow,
                    t.inspectWindow,
                    t.nonce,
                    t.signDeadline
                )
            )
        );
    }

    function depositBpsFor(uint32 volatilityBps) public view returns (uint256 bps) {
        Config memory c = config;
        bps = c.minDepositBps + (uint256(volatilityBps) * c.volMultiplierBps) / 10_000;
        if (bps > c.maxDepositBps) bps = c.maxDepositBps;
    }

    function unallocatedBalance() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > totalHeld ? bal - totalHeld : 0;
    }

    // ================================================================== internal

    function _apply(bytes32 swapId, address payer, uint256 amount, uint8 source, bytes32 ref) private {
        Swap storage s = _swaps[swapId];
        (, uint8 side) = _sideOf(s, payer);
        totalHeld += amount;
        s.funded[side] = true;
        emit Funded(swapId, payer, amount, source, ref);

        Leg storage leg = s.legs[side];
        if (leg.kind == uint8(Kind.Vaulted)) {
            nft.transferFrom(leg.owner, address(this), uint256(leg.slabId));
            s.legState[side] = LegState.Passed;
        }
        if (!s.funded[1 - side]) return;

        if (s.legState[0] == LegState.Passed && s.legState[1] == LegState.Passed) {
            _settle(swapId, s); // both vaulted: nothing to ship
        } else {
            _transition(swapId, s, Status.Locked, s.shipWindow);
        }
    }

    /// @dev Both legs passed: return deposits minus fees, pay the top-up, hand over the cards.
    function _settle(bytes32 swapId, Swap storage s) private {
        uint256 feeBps = config.feeBps;
        bool shipping;
        for (uint8 side = 0; side < 2; side++) {
            Leg storage leg = s.legs[side];
            address receiver = s.legs[1 - side].owner;
            uint256 fee = (uint256(s.refValueUsd[side]) * feeBps) / 10_000; // paid by the receiver
            _credit(receiver, swapId, s.depositUsd - fee);
            if (fee > 0) _credit(treasury, swapId, fee);

            if (leg.kind == uint8(Kind.Vaulted)) {
                nft.transferFrom(address(this), receiver, uint256(leg.slabId));
            } else if (leg.delivery == uint8(Delivery.KeepInVault)) {
                nft.mint(receiver, leg.slabId, leg.cardKey, leg.metadataHash);
            } else {
                shipping = true;
            }
        }
        if (s.topUpFrom != 0) _credit(s.legs[2 - s.topUpFrom].owner, swapId, s.topUpUsd);
        _transition(swapId, s, shipping ? Status.AwaitingDelivery : Status.Completed, 0);
    }

    /// @dev Compensation to the innocent side when `d` defaults: max(floor, spread move) capped at
    ///      the deposit. The innocent side would have given card i and received card d, so its lost
    ///      gain is (fair_d - fair_i) - (ref_d - ref_i). A stale oracle falls back to the floor.
    function _penalty(Swap storage s, uint8 d) private view returns (uint256 penalty) {
        uint8 i = 1 - d;
        uint256 base = s.refValueUsd[0] > s.refValueUsd[1] ? s.refValueUsd[0] : s.refValueUsd[1];
        penalty = (base * config.minPenaltyBps) / 10_000;
        (bool okD, uint128 fairD) = oracle.tryGetFreshPrice(s.legs[d].cardKey, config.maxPriceAge);
        (bool okI, uint128 fairI) = oracle.tryGetFreshPrice(s.legs[i].cardKey, config.maxPriceAge);
        if (okD && okI) {
            int256 moveD = int256(uint256(fairD)) - int256(uint256(s.refValueUsd[d]));
            int256 moveI = int256(uint256(fairI)) - int256(uint256(s.refValueUsd[i]));
            int256 lost = moveD - moveI;
            if (lost > 0 && uint256(lost) > penalty) penalty = uint256(lost);
        }
        if (penalty > s.depositUsd) penalty = s.depositUsd;
    }

    function _refundAll(bytes32 swapId, Swap storage s) private {
        for (uint8 side = 0; side < 2; side++) {
            if (s.funded[side]) _credit(s.legs[side].owner, swapId, _lockAmount(s, side));
        }
        _returnVaulted(s);
    }

    function _refundTopUp(bytes32 swapId, Swap storage s) private {
        if (s.topUpFrom != 0) _credit(s.legs[s.topUpFrom - 1].owner, swapId, s.topUpUsd);
    }

    function _returnVaulted(Swap storage s) private {
        for (uint8 side = 0; side < 2; side++) {
            Leg storage leg = s.legs[side];
            if (leg.kind == uint8(Kind.Vaulted) && s.funded[side]) {
                nft.transferFrom(address(this), leg.owner, uint256(leg.slabId));
            }
        }
    }

    function _lockAmount(Swap storage s, uint8 side) private view returns (uint256) {
        uint256 amount = s.depositUsd;
        if (s.topUpFrom == side + 1) amount += s.topUpUsd;
        return amount;
    }

    function _sideOf(Swap storage s, address account) private view returns (bool, uint8) {
        if (account == s.legs[0].owner) return (true, 0);
        if (account == s.legs[1].owner) return (true, 1);
        return (false, 0);
    }

    function _validateTerms(SwapTerms calldata t) private pure {
        if (
            t.a.owner == address(0) || t.b.owner == address(0) || t.a.owner == t.b.owner
                || t.a.slabId == t.b.slabId || t.a.kind > uint8(Kind.Vaulted) || t.b.kind > uint8(Kind.Vaulted)
                || t.a.delivery > uint8(Delivery.KeepInVault) || t.b.delivery > uint8(Delivery.KeepInVault)
                || t.topUpFrom > 2 || ((t.topUpFrom == 0) != (t.topUpUsd == 0)) || t.depositWindow == 0
                || t.shipWindow == 0 || t.inspectWindow == 0
        ) revert InvalidTerms();
    }

    function _checkVaulted(Leg calldata leg, uint8 side) private view {
        if (leg.kind != uint8(Kind.Vaulted)) return;
        uint256 tokenId = uint256(leg.slabId);
        if (nft.ownerOf(tokenId) != leg.owner || nft.slabOf(tokenId).cardKey != leg.cardKey) {
            revert NftMismatch(side);
        }
    }

    /// @dev What each side gives (card fair value + top-up) must be within maxValueDeviationBps.
    function _checkValueBounds(uint128 fairA, uint128 fairB, uint128 topUp, uint8 topUpFrom) private view {
        uint256 maxDev = config.maxValueDeviationBps;
        if (maxDev == 0) return;
        uint256 giveA = uint256(fairA) + (topUpFrom == 1 ? topUp : 0);
        uint256 giveB = uint256(fairB) + (topUpFrom == 2 ? topUp : 0);
        uint256 hi = giveA > giveB ? giveA : giveB;
        uint256 diff = giveA > giveB ? giveA - giveB : giveB - giveA;
        if ((diff * 10_000) / hi > maxDev) revert ValueMismatch(giveA, giveB);
    }

    function _hashLeg(Leg calldata l) private pure returns (bytes32) {
        return keccak256(abi.encode(LEG_TYPEHASH, l.owner, l.cardKey, l.slabId, l.metadataHash, l.kind, l.delivery));
    }

    function _expectedOrRevert(bytes32 swapId, address payer) private view returns (uint256 amount) {
        amount = expectedPayment(swapId, payer);
        if (amount == 0) revert NothingExpected();
    }

    function _credit(address account, bytes32 swapId, uint256 amount) private {
        if (amount == 0) return;
        credits[account] += amount;
        emit Credited(account, swapId, amount);
    }

    function _transition(bytes32 swapId, Swap storage s, Status next, uint256 window) private {
        s.status = next;
        s.deadline = window == 0 ? 0 : uint64(block.timestamp + window);
        emit StatusChanged(swapId, next, s.deadline);
    }

    function _requireStatus(bytes32 swapId, Status st) private view returns (Swap storage s) {
        s = _swaps[swapId];
        if (s.status != st) revert WrongStatus(s.status);
    }

    /// @dev USDC has 6 decimals; 1 cent = 10_000 units.
    function _ceilToCent(uint256 x) private pure returns (uint256) {
        return ((x + 9_999) / 10_000) * 10_000;
    }

    function _useNonce(address account, uint256 nonce) private {
        if (nonceUsed[account][nonce]) revert NonceAlreadyUsed(account, nonce);
        nonceUsed[account][nonce] = true;
    }

    function _setConfig(Config memory c, address treasury_) private {
        if (
            treasury_ == address(0) || c.minDepositBps == 0 || c.minDepositBps > c.maxDepositBps
                || c.maxDepositBps > 10_000 || c.minPenaltyBps > c.minDepositBps || c.feeBps > c.minDepositBps
                || c.feeBps > 1000 || c.maxPriceAge == 0
        ) revert BadConfig();
        config = c;
        treasury = treasury_;
        emit ConfigUpdated(c, treasury_);
    }
}
