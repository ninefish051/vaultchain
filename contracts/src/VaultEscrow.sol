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

/// @title VaultEscrow
/// @notice Two-sided escrow for graded-card trades. Buyer and seller both lock a deposit sized
///         from the card's price volatility; the card is inspected by the vault; the buyer then
///         pays in full. Whoever breaks the agreement compensates the other side from their
///         deposit, so neither party can walk away when the market moves.
///
///         Money can arrive three ways, all funnelled through the same accounting:
///           1. `fund`                    — ERC-20 approval + transferFrom
///           2. `fundWithAuthorization`   — EIP-3009 signature (USDC), no approval needed
///           3. `recordHspPayment`        — HSP Gateway already transferred USDC to this contract
///                                          (pay_to = escrow); a relayer attributes it to an order.
///
///         Payouts use a pull pattern (`credits` + `withdraw`).
contract VaultEscrow is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ roles

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE"); // inspection, delivery, returns
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE"); // dispute resolution (multisig)
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE"); // attributes HSP payments
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE"); // funds company buyouts

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Signed, // both signatures verified, waiting for both deposits
        Locked, // deposits locked, waiting for the seller to ship to the vault
        Inspecting, // card at the vault
        PaymentWindow, // inspection passed, seller deposit released, buyer must pay in full
        Disputed, // inspection failed or timed out, arbiter decides
        AwaitingDelivery, // paid, vault ships the card to the buyer
        Completed, // delivered, or NFT minted to the buyer
        BuyerDefault, // buyer missed the payment deadline
        SellerDefault, // seller never shipped
        Cancelled, // deposits never completed
        Refunded, // dispute resolved
        Returned, // after buyer default, card returned to the seller
        BoughtOut // after buyer default, company bought the card
    }

    enum Fulfillment {
        ShipToBuyer,
        KeepInVault
    }

    /// @notice Terms signed by both parties (EIP-712).
    struct OrderTerms {
        address buyer;
        address seller;
        bytes32 cardKey; // card type, used to read the oracle
        bytes32 slabId; // keccak256(grader, certNumber): the specific card
        bytes32 metadataHash; // used when minting the NFT
        uint128 priceUsd; // 6 decimals
        uint32 depositWindow; // seconds to lock both deposits
        uint32 shipWindow; // seconds for the seller to ship to the vault
        uint32 inspectWindow; // seconds for the vault to inspect
        uint32 payWindow; // seconds for the buyer to pay in full
        uint8 fulfillment; // Fulfillment
        uint256 nonce;
        uint64 signDeadline; // signatures expire after this
    }

    struct Order {
        address buyer;
        address seller;
        bytes32 cardKey;
        bytes32 slabId;
        bytes32 metadataHash;
        uint128 priceUsd;
        uint128 depositUsd; // per side
        uint128 refFairValueUsd; // oracle fair value when the order was created
        uint32 shipWindow;
        uint32 inspectWindow;
        uint32 payWindow;
        uint64 deadline; // deadline of the current stage
        Fulfillment fulfillment;
        Status status;
        bool buyerDeposited;
        bool sellerDeposited;
        bool sellerBuyoutConsent;
    }

    struct Config {
        uint16 minDepositBps; // e.g. 1000 = 10%
        uint16 maxDepositBps; // e.g. 3000 = 30%
        uint32 volMultiplierBps; // deposit = min + vol * multiplier; 20000 = 2x
        uint16 minPenaltyBps; // floor compensation on default, e.g. 500 = 5%
        uint16 feeBps; // platform fee on completed sales
        uint16 maxPriceDeviationBps; // hard bound vs fair value, 0 = disabled
        uint32 maxPriceAge; // oracle staleness limit, seconds
    }

    bytes32 public constant ORDER_TERMS_TYPEHASH = keccak256(
        "OrderTerms(address buyer,address seller,bytes32 cardKey,bytes32 slabId,bytes32 metadataHash,uint128 priceUsd,uint32 depositWindow,uint32 shipWindow,uint32 inspectWindow,uint32 payWindow,uint8 fulfillment,uint256 nonce,uint64 signDeadline)"
    );

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdc;
    CardPriceOracle public immutable oracle;
    VaultCardNFT public immutable nft;
    address public treasury;
    Config public config;

    mapping(bytes32 orderId => Order) private _orders;
    mapping(address account => mapping(uint256 nonce => bool)) public nonceUsed;
    mapping(bytes32 paymentRef => bool) public paymentRefUsed;
    mapping(address account => uint256) public credits;

    /// @notice USDC this contract owes to orders and credit holders. Anything above this in the
    ///         balance is unallocated (e.g. an HSP transfer not yet attributed).
    uint256 public totalHeld;

    // ------------------------------------------------------------------ events

    event OrderCreated(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed seller,
        bytes32 slabId,
        uint128 priceUsd,
        uint128 depositUsd,
        uint128 refFairValueUsd
    );
    event StatusChanged(bytes32 indexed orderId, Status status, uint64 deadline);
    event Funded(bytes32 indexed orderId, address indexed payer, uint256 amount, uint8 source, bytes32 paymentRef);
    event Shipped(bytes32 indexed orderId, bytes32 trackingHash);
    event Inspected(bytes32 indexed orderId, bool passed, bytes32 reportHash);
    event DefaultSettled(bytes32 indexed orderId, address indexed defaulter, uint256 penalty);
    event DisputeResolved(bytes32 indexed orderId, uint256 buyerAward);
    event Credited(address indexed account, bytes32 indexed orderId, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event NonceCancelled(address indexed account, uint256 nonce);
    event ConfigUpdated(Config config, address treasury);

    // ------------------------------------------------------------------ errors

    error InvalidTerms();
    error SignatureExpired();
    error BadSignature(address signer);
    error NonceAlreadyUsed(address account, uint256 nonce);
    error OrderExists();
    error WrongStatus(Status current);
    error NotParty();
    error NothingExpected();
    error DeadlinePassed();
    error DeadlineNotReached();
    error PriceOutOfBounds(uint128 priceUsd, uint128 fairValueUsd);
    error InsufficientUnallocated(uint256 available, uint256 amount);
    error PaymentRefUsed();
    error AmountMismatch(uint256 expected, uint256 got);
    error AwardTooLarge();
    error NoConsent();
    error NothingToWithdraw();
    error BadConfig();

    uint8 private constant SRC_TRANSFER = 0;
    uint8 private constant SRC_EIP3009 = 1;
    uint8 private constant SRC_HSP = 2;

    // ------------------------------------------------------------------ constructor

    constructor(
        address admin,
        IERC20 usdc_,
        CardPriceOracle oracle_,
        VaultCardNFT nft_,
        address treasury_,
        Config memory config_
    ) EIP712("VaultChain Escrow", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        oracle = oracle_;
        nft = nft_;
        _setConfig(config_, treasury_);
    }

    // ================================================================== 1. sign

    /// @notice Creates an order from terms signed by both parties. Anyone may submit
    ///         (typically the buyer's agent). Deposits are sized from the oracle volatility.
    function createOrder(OrderTerms calldata t, bytes calldata buyerSig, bytes calldata sellerSig)
        external
        returns (bytes32 orderId)
    {
        if (
            t.buyer == address(0) || t.seller == address(0) || t.buyer == t.seller || t.priceUsd == 0
                || t.depositWindow == 0 || t.shipWindow == 0 || t.inspectWindow == 0 || t.payWindow == 0
                || t.fulfillment > uint8(Fulfillment.KeepInVault)
        ) revert InvalidTerms();
        if (block.timestamp > t.signDeadline) revert SignatureExpired();

        orderId = hashOrderTerms(t);
        if (_orders[orderId].status != Status.None) revert OrderExists();
        if (!SignatureChecker.isValidSignatureNow(t.buyer, orderId, buyerSig)) revert BadSignature(t.buyer);
        if (!SignatureChecker.isValidSignatureNow(t.seller, orderId, sellerSig)) revert BadSignature(t.seller);
        _useNonce(t.buyer, t.nonce);
        _useNonce(t.seller, t.nonce);
        nft.lockSlab(t.slabId); // one active trade per physical slab; vaulted slabs trade as NFTs

        CardPriceOracle.PricePoint memory p = oracle.getFreshPrice(t.cardKey, config.maxPriceAge);
        _checkPriceBounds(t.priceUsd, p.fairValueUsd);
        // rounded up to a whole cent so fiat-denominated rails (HSP carts are USD with 2 decimals) can pay it exactly
        uint128 deposit = uint128(_ceilToCent((uint256(t.priceUsd) * depositBpsFor(p.volatilityBps)) / 10_000));

        Order storage o = _orders[orderId];
        o.buyer = t.buyer;
        o.seller = t.seller;
        o.cardKey = t.cardKey;
        o.slabId = t.slabId;
        o.metadataHash = t.metadataHash;
        o.priceUsd = t.priceUsd;
        o.depositUsd = deposit;
        o.refFairValueUsd = p.fairValueUsd;
        o.shipWindow = t.shipWindow;
        o.inspectWindow = t.inspectWindow;
        o.payWindow = t.payWindow;
        o.fulfillment = Fulfillment(t.fulfillment);

        emit OrderCreated(orderId, t.buyer, t.seller, t.slabId, t.priceUsd, deposit, p.fairValueUsd);
        _transition(orderId, o, Status.Signed, t.depositWindow);
    }

    /// @notice Invalidate a nonce so an order signed but not yet submitted can never be created.
    function cancelNonce(uint256 nonce) external {
        _useNonce(msg.sender, nonce);
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice If both deposits are not in by the deadline, refund whatever arrived.
    function cancelUnfunded(bytes32 orderId) external nonReentrant {
        Order storage o = _requireStatus(orderId, Status.Signed);
        if (block.timestamp <= o.deadline) revert DeadlineNotReached();
        if (o.buyerDeposited) _credit(o.buyer, orderId, o.depositUsd);
        if (o.sellerDeposited) _credit(o.seller, orderId, o.depositUsd);
        _transition(orderId, o, Status.Cancelled, 0);
    }

    // ================================================================== 2. fund (deposits + final payment)

    /// @notice What `payer` must pay next for this order (0 if nothing).
    function expectedPayment(bytes32 orderId, address payer) public view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.status == Status.Signed && block.timestamp <= o.deadline) {
            if (payer == o.buyer && !o.buyerDeposited) return o.depositUsd;
            if (payer == o.seller && !o.sellerDeposited) return o.depositUsd;
        } else if (o.status == Status.PaymentWindow && block.timestamp <= o.deadline && payer == o.buyer) {
            return o.priceUsd;
        }
        return 0;
    }

    /// @notice Pay the next amount due (deposit or final payment) using an ERC-20 approval.
    function fund(bytes32 orderId) external nonReentrant {
        uint256 amount = _expectedOrRevert(orderId, msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _apply(orderId, msg.sender, amount, SRC_TRANSFER, bytes32(0));
    }

    /// @notice Pay the next amount due with an EIP-3009 `receiveWithAuthorization` signed by `payer`.
    function fundWithAuthorization(
        bytes32 orderId,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint256 amount = _expectedOrRevert(orderId, payer);
        IERC3009(address(usdc)).receiveWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        _apply(orderId, payer, amount, SRC_EIP3009, nonce);
    }

    /// @notice Attribute a payment that the HSP Gateway already transferred to this contract.
    /// @dev    The relayer can only claim USDC that is in the balance but not yet owed to anyone,
    ///         so it cannot create money; `paymentRef` (e.g. keccak of the HSP payment_request_id)
    ///         prevents the same HSP payment from being counted twice.
    function recordHspPayment(bytes32 orderId, address payer, uint256 amount, bytes32 paymentRef)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
    {
        if (paymentRefUsed[paymentRef]) revert PaymentRefUsed();
        uint256 expected = _expectedOrRevert(orderId, payer);
        if (amount != expected) revert AmountMismatch(expected, amount);
        uint256 available = unallocatedBalance();
        if (available < amount) revert InsufficientUnallocated(available, amount);
        paymentRefUsed[paymentRef] = true;
        _apply(orderId, payer, amount, SRC_HSP, paymentRef);
    }

    // ================================================================== 3. ship + inspect

    function markShipped(bytes32 orderId, bytes32 trackingHash) external {
        Order storage o = _requireStatus(orderId, Status.Locked);
        if (msg.sender != o.seller) revert NotParty();
        if (block.timestamp > o.deadline) revert DeadlinePassed();
        emit Shipped(orderId, trackingHash);
        _transition(orderId, o, Status.Inspecting, o.inspectWindow);
    }

    /// @notice Seller never shipped: buyer is compensated from the seller deposit.
    function claimSellerNoShow(bytes32 orderId) external nonReentrant {
        Order storage o = _requireStatus(orderId, Status.Locked);
        if (block.timestamp <= o.deadline) revert DeadlineNotReached();
        uint256 penalty = _penalty(o, false);
        _credit(o.buyer, orderId, uint256(o.depositUsd) + penalty);
        _credit(o.seller, orderId, o.depositUsd - penalty);
        emit DefaultSettled(orderId, o.seller, penalty);
        _transition(orderId, o, Status.SellerDefault, 0);
    }

    /// @notice Vault records the inspection result. Passing releases the seller deposit (step 4)
    ///         and opens the buyer payment window.
    function submitInspection(bytes32 orderId, bool passed, bytes32 reportHash)
        external
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        Order storage o = _requireStatus(orderId, Status.Inspecting);
        emit Inspected(orderId, passed, reportHash);
        if (passed) {
            _credit(o.seller, orderId, o.depositUsd);
            _transition(orderId, o, Status.PaymentWindow, o.payWindow);
        } else {
            _transition(orderId, o, Status.Disputed, 0);
        }
    }

    /// @notice If the vault does not report in time, anyone can escalate to the arbiter.
    function escalateInspectionTimeout(bytes32 orderId) external {
        Order storage o = _requireStatus(orderId, Status.Inspecting);
        if (block.timestamp <= o.deadline) revert DeadlineNotReached();
        _transition(orderId, o, Status.Disputed, 0);
    }

    /// @notice Arbiter settles a dispute. The buyer always gets their deposit back, plus
    ///         `buyerAward` taken from the seller deposit (0 = no fault, full = seller at fault).
    function resolveDispute(bytes32 orderId, uint256 buyerAward) external onlyRole(ARBITER_ROLE) nonReentrant {
        Order storage o = _requireStatus(orderId, Status.Disputed);
        if (buyerAward > o.depositUsd) revert AwardTooLarge();
        _credit(o.buyer, orderId, uint256(o.depositUsd) + buyerAward);
        _credit(o.seller, orderId, o.depositUsd - buyerAward);
        emit DisputeResolved(orderId, buyerAward);
        _transition(orderId, o, Status.Refunded, 0);
    }

    // ================================================================== 4. payment outcome

    /// @notice Buyer missed the deadline: seller is compensated from the buyer deposit.
    function claimBuyerDefault(bytes32 orderId) external nonReentrant {
        Order storage o = _requireStatus(orderId, Status.PaymentWindow);
        if (block.timestamp <= o.deadline) revert DeadlineNotReached();
        uint256 penalty = _penalty(o, true);
        _credit(o.seller, orderId, penalty);
        _credit(o.buyer, orderId, o.depositUsd - penalty);
        emit DefaultSettled(orderId, o.buyer, penalty);
        _transition(orderId, o, Status.BuyerDefault, 0);
    }

    function confirmDelivered(bytes32 orderId) external onlyRole(VAULT_ROLE) {
        Order storage o = _requireStatus(orderId, Status.AwaitingDelivery);
        _transition(orderId, o, Status.Completed, 0);
    }

    // ------------------------------------------------------------------ after buyer default

    function consentToBuyout(bytes32 orderId) external {
        Order storage o = _requireStatus(orderId, Status.BuyerDefault);
        if (msg.sender != o.seller) revert NotParty();
        o.sellerBuyoutConsent = true;
    }

    /// @notice Company buys the card at the agreed price from its reserve and receives the NFT.
    function executeBuyout(bytes32 orderId) external onlyRole(TREASURY_ROLE) nonReentrant {
        Order storage o = _requireStatus(orderId, Status.BuyerDefault);
        if (!o.sellerBuyoutConsent) revert NoConsent();
        usdc.safeTransferFrom(msg.sender, address(this), o.priceUsd);
        totalHeld += o.priceUsd;
        _credit(o.seller, orderId, o.priceUsd);
        nft.mint(msg.sender, o.slabId, o.cardKey, o.metadataHash);
        _transition(orderId, o, Status.BoughtOut, 0);
    }

    function markReturned(bytes32 orderId) external onlyRole(VAULT_ROLE) {
        Order storage o = _requireStatus(orderId, Status.BuyerDefault);
        _transition(orderId, o, Status.Returned, 0);
    }

    // ================================================================== withdrawals

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        totalHeld -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ================================================================== admin

    function setConfig(Config calldata c, address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(c, treasury_);
    }

    /// @notice Return USDC that arrived but was never attributed to an order (e.g. a mistaken
    ///         HSP payment). Funds owed to orders can never be touched.
    function rescueUnallocated(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 available = unallocatedBalance();
        if (amount > available) revert InsufficientUnallocated(available, amount);
        usdc.safeTransfer(to, amount);
    }

    // ================================================================== views

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function hashOrderTerms(OrderTerms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TERMS_TYPEHASH,
                    t.buyer,
                    t.seller,
                    t.cardKey,
                    t.slabId,
                    t.metadataHash,
                    t.priceUsd,
                    t.depositWindow,
                    t.shipWindow,
                    t.inspectWindow,
                    t.payWindow,
                    t.fulfillment,
                    t.nonce,
                    t.signDeadline
                )
            )
        );
    }

    /// @notice deposit bps = clamp(minDeposit + volatility * multiplier, minDeposit, maxDeposit)
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

    function _apply(bytes32 orderId, address payer, uint256 amount, uint8 source, bytes32 ref) private {
        Order storage o = _orders[orderId];
        totalHeld += amount;
        emit Funded(orderId, payer, amount, source, ref);

        if (o.status == Status.Signed) {
            if (payer == o.buyer) o.buyerDeposited = true;
            else o.sellerDeposited = true;
            if (o.buyerDeposited && o.sellerDeposited) _transition(orderId, o, Status.Locked, o.shipWindow);
        } else {
            // PaymentWindow: full payment received
            uint256 fee = (uint256(o.priceUsd) * config.feeBps) / 10_000;
            _credit(o.seller, orderId, o.priceUsd - fee);
            if (fee > 0) _credit(treasury, orderId, fee);
            _credit(o.buyer, orderId, o.depositUsd); // return the buyer's separate collateral
            if (o.fulfillment == Fulfillment.KeepInVault) {
                nft.mint(o.buyer, o.slabId, o.cardKey, o.metadataHash);
                _transition(orderId, o, Status.Completed, 0);
            } else {
                _transition(orderId, o, Status.AwaitingDelivery, 0);
            }
        }
    }

    /// @dev Compensation for the non-defaulting side: at least minPenaltyBps of the price, or the
    ///      adverse market move since signing if larger, capped at the defaulter's deposit.
    ///      Buyer default hurts the seller when the price fell; seller default hurts the buyer
    ///      when the price rose. A stale oracle falls back to the floor.
    function _penalty(Order storage o, bool buyerDefaulted) private view returns (uint256 penalty) {
        penalty = (uint256(o.priceUsd) * config.minPenaltyBps) / 10_000;
        (bool ok, uint128 fair) = oracle.tryGetFreshPrice(o.cardKey, config.maxPriceAge);
        if (ok) {
            uint256 ref = o.refFairValueUsd;
            uint256 move;
            if (buyerDefaulted && fair < ref) move = ((ref - fair) * o.priceUsd) / ref;
            if (!buyerDefaulted && fair > ref) move = ((fair - ref) * o.priceUsd) / ref;
            if (move > penalty) penalty = move;
        }
        if (penalty > o.depositUsd) penalty = o.depositUsd;
    }

    function _expectedOrRevert(bytes32 orderId, address payer) private view returns (uint256 amount) {
        amount = expectedPayment(orderId, payer);
        if (amount == 0) revert NothingExpected();
    }

    function _credit(address account, bytes32 orderId, uint256 amount) private {
        if (amount == 0) return;
        credits[account] += amount;
        emit Credited(account, orderId, amount);
    }

    function _transition(bytes32 orderId, Order storage o, Status next, uint256 window) private {
        o.status = next;
        o.deadline = window == 0 ? 0 : uint64(block.timestamp + window);
        emit StatusChanged(orderId, next, o.deadline);
        // The slab is free to trade again once the order is over (and the card handed over or returned).
        if (
            next == Status.Completed || next == Status.SellerDefault || next == Status.Cancelled
                || next == Status.Refunded || next == Status.Returned || next == Status.BoughtOut
        ) nft.unlockSlab(o.slabId);
    }

    function _requireStatus(bytes32 orderId, Status s) private view returns (Order storage o) {
        o = _orders[orderId];
        if (o.status != s) revert WrongStatus(o.status);
    }

    /// @dev USDC has 6 decimals; 1 cent = 10_000 units.
    function _ceilToCent(uint256 x) private pure returns (uint256) {
        return ((x + 9_999) / 10_000) * 10_000;
    }

    function _useNonce(address account, uint256 nonce) private {
        if (nonceUsed[account][nonce]) revert NonceAlreadyUsed(account, nonce);
        nonceUsed[account][nonce] = true;
    }

    function _checkPriceBounds(uint128 price, uint128 fair) private view {
        uint256 maxDev = config.maxPriceDeviationBps;
        if (maxDev == 0) return;
        uint256 diff = price > fair ? price - fair : fair - price;
        if ((diff * 10_000) / fair > maxDev) revert PriceOutOfBounds(price, fair);
    }

    function _setConfig(Config memory c, address treasury_) private {
        if (
            treasury_ == address(0) || c.minDepositBps == 0 || c.minDepositBps > c.maxDepositBps
                || c.maxDepositBps > 10_000 || c.minPenaltyBps > c.minDepositBps || c.feeBps > 1000
                || c.maxPriceAge == 0
        ) revert BadConfig();
        config = c;
        treasury = treasury_;
        emit ConfigUpdated(c, treasury_);
    }
}
