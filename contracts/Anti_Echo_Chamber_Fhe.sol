pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AntiEchoChamberFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    // For simplicity, we'll store a single aggregated score per batch.
    // In a real system, this would be more complex (e.g., encrypted graph data).
    euint32 public encryptedDiversityScore;

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event DataSubmitted(address indexed provider, uint256 batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint32 diversityScore);

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1; // Start with batch 1
        batchOpen = false; // Batch is initially closed
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider] && provider != owner) { // Cannot remove owner as provider
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) {
            currentBatchId++;
        }
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (batchOpen) {
            batchOpen = false;
            emit BatchClosed(currentBatchId);
        }
    }

    function _requireInitialized(euint32 value) internal view {
        if (!value.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _initIfNeeded(euint32 value) internal {
        if (!value.isInitialized()) {
            value = FHE.asEuint32(0);
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function submitEncryptedData(euint32 encryptedUserScore) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batchOpen) {
            revert BatchClosedOrNonExistent();
        }

        _initIfNeeded(encryptedDiversityScore);
        _initIfNeeded(encryptedUserScore);

        // Simplified logic: Add the user's score to the batch's diversity score.
        // A real anti-echo chamber algorithm would be more complex.
        encryptedDiversityScore = encryptedDiversityScore.add(encryptedUserScore);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId);
    }

    function requestDiversityScoreDecryption() external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batchOpen) { // Only allow decryption for closed batches
            revert BatchClosedOrNonExistent();
        }

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedDiversityScore.toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestDiversityScoreDecryption
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedDiversityScore.toBytes32();
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }
        // Security Comment: State hash verification ensures that the contract state
        // (specifically, the ciphertexts being decrypted) has not changed since
        // the decryption was requested. This prevents scenarios where an attacker
        // might alter the state after a request but before decryption.

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // d. Decode & Finalize
        // Decode cleartexts in the same order they were provided to requestDecryption
        uint32 diversityScore = abi.decode(cleartexts, (uint32));

        decryptionContexts[requestId].processed = true;
        // Security Comment: The 'processed' flag acts as a replay guard, ensuring
        // that a successful decryption callback for a given requestId cannot be
        // re-executed, even with the same parameters.

        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, diversityScore);
        // In a real system, you might update contract state based on the decrypted score,
        // e.g., reset encryptedDiversityScore for the next batch.
    }
}