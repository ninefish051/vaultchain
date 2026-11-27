// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title VaultCardNFT
/// @notice One token per physical graded card ("slab") held in a VaultChain vault.
///         tokenId = uint256(slabId) where slabId = keccak256(grader, certNumber), so a slab
///         can never be represented twice. Redemption and off-platform sales lock the token
///         until the vault confirms handover, then burn it.
contract VaultCardNFT is ERC721, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // VaultEscrow + vault intake
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE"); // vault operator

    enum Custody {
        None, // not minted / burned
        InVault, // freely transferable
        RedeemLocked, // owner requested physical delivery
        ExternalSaleLocked // sold as a physical item on eBay / Carousell, awaiting handover
    }

    struct Slab {
        bytes32 cardKey; // card type used for pricing
        bytes32 metadataHash; // hash of grader, cert number, front/back image hashes
        Custody custody;
    }

    mapping(uint256 tokenId => Slab) private _slabs;
    string private _baseTokenURI;

    event SlabMinted(uint256 indexed tokenId, address indexed to, bytes32 indexed cardKey, bytes32 metadataHash);
    event CustodyChanged(uint256 indexed tokenId, Custody custody);
    event SlabRetired(uint256 indexed tokenId, address indexed lastOwner, Custody reason);

    error NotTokenOwner();
    error WrongCustody(Custody current);
    error TokenLocked(uint256 tokenId, Custody custody);

    constructor(address admin, string memory baseURI) ERC721("VaultChain Card", "VCARD") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _baseTokenURI = baseURI;
    }

    // ------------------------------------------------------------------ mint

    function mint(address to, bytes32 slabId, bytes32 cardKey, bytes32 metadataHash)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        tokenId = uint256(slabId);
        _slabs[tokenId] = Slab({cardKey: cardKey, metadataHash: metadataHash, custody: Custody.InVault});
        _safeMint(to, tokenId); // reverts if the slab is already minted
        emit SlabMinted(tokenId, to, cardKey, metadataHash);
    }

    // ------------------------------------------------------------------ redemption

    function requestRedeem(uint256 tokenId) external {
        _requireOwner(tokenId);
        _setCustody(tokenId, Custody.InVault, Custody.RedeemLocked);
    }

    /// @notice Owner may cancel before the vault ships; the vault may also cancel (e.g. bad address).
    function cancelRedeem(uint256 tokenId) external {
        if (msg.sender != _ownerOf(tokenId) && !hasRole(VAULT_ROLE, msg.sender)) revert NotTokenOwner();
        _setCustody(tokenId, Custody.RedeemLocked, Custody.InVault);
    }

    function completeRedeem(uint256 tokenId) external onlyRole(VAULT_ROLE) {
        _retire(tokenId, Custody.RedeemLocked);
    }

    // ------------------------------------------------------------------ physical sale elsewhere

    function lockForExternalSale(uint256 tokenId) external {
        _requireOwner(tokenId);
        _setCustody(tokenId, Custody.InVault, Custody.ExternalSaleLocked);
    }

    function cancelExternalSale(uint256 tokenId) external onlyRole(VAULT_ROLE) {
        _setCustody(tokenId, Custody.ExternalSaleLocked, Custody.InVault);
    }

    function completeExternalSale(uint256 tokenId) external onlyRole(VAULT_ROLE) {
        _retire(tokenId, Custody.ExternalSaleLocked);
    }

    // ------------------------------------------------------------------ views

    function slabOf(uint256 tokenId) external view returns (Slab memory) {
        return _slabs[tokenId];
    }

    function custodyOf(uint256 tokenId) external view returns (Custody) {
        return _slabs[tokenId].custody;
    }

    function setBaseURI(string calldata baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _baseTokenURI = baseURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseTokenURI, tokenId.toHexString(32));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ internal

    /// @dev Block transfers (not mint/burn) while a token is locked.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            Custody c = _slabs[tokenId].custody;
            if (c != Custody.InVault) revert TokenLocked(tokenId, c);
        }
        return super._update(to, tokenId, auth);
    }

    function _requireOwner(uint256 tokenId) private view {
        if (_ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
    }

    function _setCustody(uint256 tokenId, Custody expected, Custody next) private {
        Custody c = _slabs[tokenId].custody;
        if (c != expected) revert WrongCustody(c);
        _slabs[tokenId].custody = next;
        emit CustodyChanged(tokenId, next);
    }

    function _retire(uint256 tokenId, Custody expected) private {
        Custody c = _slabs[tokenId].custody;
        if (c != expected) revert WrongCustody(c);
        address owner = _ownerOf(tokenId);
        _burn(tokenId);
        delete _slabs[tokenId];
        emit SlabRetired(tokenId, owner, expected);
    }
}
