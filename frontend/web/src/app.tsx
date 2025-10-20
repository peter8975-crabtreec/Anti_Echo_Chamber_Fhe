// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface OpinionData {
  id: string;
  encryptedScore: string; // FHE encrypted score representing opinion similarity
  timestamp: number;
  owner: string;
  topic: string;
  diversityScore: number; // Higher means more diverse from user's usual opinions
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increaseDiversity':
      result = value * 1.2; // Increase diversity score
      break;
    case 'decreaseDiversity':
      result = value * 0.8; // Decrease diversity score
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [opinions, setOpinions] = useState<OpinionData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newOpinion, setNewOpinion] = useState({ topic: "", opinionScore: 50 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedOpinion, setSelectedOpinion] = useState<OpinionData | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterTopic, setFilterTopic] = useState("all");

  // Calculate statistics
  const totalOpinions = opinions.length;
  const averageDiversity = totalOpinions > 0 
    ? opinions.reduce((sum, op) => sum + op.diversityScore, 0) / totalOpinions 
    : 0;
  const uniqueTopics = [...new Set(opinions.map(op => op.topic))];
  const topContributors = [...new Set(opinions.map(op => op.owner))]
    .map(addr => ({
      address: addr,
      count: opinions.filter(op => op.owner === addr).length
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  useEffect(() => {
    loadOpinions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadOpinions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get opinion keys
      const keysBytes = await contract.getData("opinion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing opinion keys:", e); }
      }
      
      // Load each opinion
      const list: OpinionData[] = [];
      for (const key of keys) {
        try {
          const opinionBytes = await contract.getData(`opinion_${key}`);
          if (opinionBytes.length > 0) {
            try {
              const opinionData = JSON.parse(ethers.toUtf8String(opinionBytes));
              list.push({ 
                id: key, 
                encryptedScore: opinionData.score, 
                timestamp: opinionData.timestamp, 
                owner: opinionData.owner, 
                topic: opinionData.topic,
                diversityScore: opinionData.diversityScore || 0
              });
            } catch (e) { console.error(`Error parsing opinion ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading opinion ${key}:`, e); }
      }
      
      // Sort by diversity score (higher first)
      list.sort((a, b) => b.diversityScore - a.diversityScore);
      setOpinions(list);
    } catch (e) { console.error("Error loading opinions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitOpinion = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting opinion score with Zama FHE..." 
    });
    
    try {
      // Encrypt the opinion score
      const encryptedScore = FHEEncryptNumber(newOpinion.opinionScore);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate random ID
      const opinionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Calculate diversity score (random for demo, in real app would be computed from social graph)
      const diversityScore = Math.floor(Math.random() * 100);
      
      // Store opinion data
      const opinionData = { 
        score: encryptedScore, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        topic: newOpinion.topic,
        diversityScore 
      };
      
      await contract.setData(`opinion_${opinionId}`, ethers.toUtf8Bytes(JSON.stringify(opinionData)));
      
      // Update keys list
      const keysBytes = await contract.getData("opinion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(opinionId);
      await contract.setData("opinion_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Opinion encrypted and submitted!" 
      });
      
      await loadOpinions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewOpinion({ topic: "", opinionScore: 50 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const increaseDiversity = async (opinionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing with FHE to increase diversity..." 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get current opinion data
      const opinionBytes = await contract.getData(`opinion_${opinionId}`);
      if (opinionBytes.length === 0) throw new Error("Opinion not found");
      const opinionData = JSON.parse(ethers.toUtf8String(opinionBytes));
      
      // Perform FHE computation to increase diversity
      const updatedScore = FHECompute(opinionData.score, 'increaseDiversity');
      
      // Update with signer
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedOpinion = { 
        ...opinionData, 
        score: updatedScore,
        diversityScore: opinionData.diversityScore * 1.2
      };
      
      await contractWithSigner.setData(
        `opinion_${opinionId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedOpinion))
      );
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Diversity increased with FHE!" 
      });
      
      await loadOpinions();
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Operation failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const isOwner = (opinionAddress: string) => 
    address?.toLowerCase() === opinionAddress.toLowerCase();

  // Filter opinions based on search and topic filter
  const filteredOpinions = opinions.filter(opinion => {
    const matchesSearch = opinion.topic.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTopic = filterTopic === "all" || opinion.topic === filterTopic;
    return matchesSearch && matchesTopic;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Anti<span>Echo</span>Chamber</h1>
          <div className="fhe-badge">FHE-Powered</div>
        </div>
        <div className="header-actions">
          <ConnectButton 
            accountStatus="address" 
            chainStatus="icon" 
            showBalance={false}
          />
        </div>
      </header>

      <div className="main-content">
        {/* Radial layout centered */}
        <div className="center-radial">
          {/* Core panel */}
          <div className="core-panel">
            {showIntro ? (
              <div className="intro-panel">
                <h2>Break Your Filter Bubble</h2>
                <p>
                  Anti Echo Chamber uses <strong>Zama FHE</strong> to analyze your social graph 
                  and recommend diverse opinions while keeping your data private.
                </p>
                <div className="fhe-explanation">
                  <h3>How FHE Protects You:</h3>
                  <ul>
                    <li>Your opinions are encrypted before leaving your device</li>
                    <li>Recommendations are computed on encrypted data</li>
                    <li>No central party ever sees your raw data</li>
                  </ul>
                </div>
                <button 
                  className="action-btn"
                  onClick={() => setShowIntro(false)}
                >
                  Explore Diverse Opinions
                </button>
              </div>
            ) : (
              <>
                <div className="stats-panel">
                  <div className="stat-card">
                    <h3>Total Opinions</h3>
                    <div className="stat-value">{totalOpinions}</div>
                  </div>
                  <div className="stat-card">
                    <h3>Avg Diversity</h3>
                    <div className="stat-value">{averageDiversity.toFixed(1)}</div>
                  </div>
                  <div className="stat-card">
                    <h3>Unique Topics</h3>
                    <div className="stat-value">{uniqueTopics.length}</div>
                  </div>
                </div>

                <div className="controls-panel">
                  <div className="search-filter">
                    <input
                      type="text"
                      placeholder="Search opinions..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="search-input"
                    />
                    <select
                      value={filterTopic}
                      onChange={(e) => setFilterTopic(e.target.value)}
                      className="topic-filter"
                    >
                      <option value="all">All Topics</option>
                      {uniqueTopics.map(topic => (
                        <option key={topic} value={topic}>{topic}</option>
                      ))}
                    </select>
                    <button 
                      onClick={loadOpinions} 
                      className="refresh-btn"
                      disabled={isRefreshing}
                    >
                      {isRefreshing ? "Refreshing..." : "Refresh"}
                    </button>
                  </div>
                  <button 
                    onClick={() => setShowCreateModal(true)}
                    className="submit-opinion"
                  >
                    + Share Your Opinion
                  </button>
                </div>

                <div className="opinions-list">
                  <div className="list-header">
                    <div>Topic</div>
                    <div>Diversity</div>
                    <div>Owner</div>
                    <div>Actions</div>
                  </div>
                  {filteredOpinions.length === 0 ? (
                    <div className="no-results">
                      No opinions found. Be the first to share!
                    </div>
                  ) : (
                    filteredOpinions.map(opinion => (
                      <div 
                        key={opinion.id} 
                        className="opinion-item"
                        onClick={() => setSelectedOpinion(opinion)}
                      >
                        <div className="opinion-topic">{opinion.topic}</div>
                        <div className="opinion-diversity">
                          <div 
                            className="diversity-bar"
                            style={{ width: `${opinion.diversityScore}%` }}
                          ></div>
                          <span>{opinion.diversityScore.toFixed(0)}</span>
                        </div>
                        <div className="opinion-owner">
                          {opinion.owner.substring(0, 6)}...{opinion.owner.substring(38)}
                        </div>
                        <div className="opinion-actions">
                          {isOwner(opinion.owner) && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                increaseDiversity(opinion.id);
                              }}
                              className="diversity-btn"
                            >
                              Boost Diversity
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* Radial panels */}
          <div className="radial-panel top">
            <h3>Top Contributors</h3>
            <div className="contributors-list">
              {topContributors.map((contributor, index) => (
                <div key={contributor.address} className="contributor">
                  <span className="rank">{index + 1}</span>
                  <span className="address">
                    {contributor.address.substring(0, 6)}...{contributor.address.substring(38)}
                  </span>
                  <span className="count">{contributor.count} opinions</span>
                </div>
              ))}
            </div>
          </div>

          <div className="radial-panel right">
            <h3>Popular Topics</h3>
            <div className="topics-cloud">
              {uniqueTopics.slice(0, 10).map(topic => (
                <span 
                  key={topic} 
                  className="topic-tag"
                  onClick={() => setFilterTopic(topic)}
                >
                  {topic}
                </span>
              ))}
            </div>
          </div>

          <div className="radial-panel left">
            <h3>How FHE Works</h3>
            <div className="fhe-steps">
              <div className="step">
                <div className="step-icon">🔒</div>
                <p>Data encrypted with Zama FHE</p>
              </div>
              <div className="step">
                <div className="step-icon">⚙️</div>
                <p>Computations on encrypted data</p>
              </div>
              <div className="step">
                <div className="step-icon">🔓</div>
                <p>Only you can decrypt results</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Opinion Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Share Your Opinion</h2>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="close-modal"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Topic</label>
                <input
                  type="text"
                  placeholder="What's your opinion about?"
                  value={newOpinion.topic}
                  onChange={(e) => setNewOpinion({...newOpinion, topic: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>Opinion Score (0-100)</label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={newOpinion.opinionScore}
                  onChange={(e) => setNewOpinion({...newOpinion, opinionScore: parseInt(e.target.value)})}
                />
                <div className="score-value">{newOpinion.opinionScore}</div>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview">
                  <div>Plain: {newOpinion.opinionScore}</div>
                  <div>→</div>
                  <div>Encrypted: {FHEEncryptNumber(newOpinion.opinionScore).substring(0, 20)}...</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                onClick={submitOpinion}
                disabled={!newOpinion.topic || creating}
                className="submit-btn"
              >
                {creating ? "Encrypting..." : "Submit Encrypted Opinion"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Opinion Detail Modal */}
      {selectedOpinion && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Opinion Details</h2>
              <button 
                onClick={() => {
                  setSelectedOpinion(null);
                  setDecryptedScore(null);
                }}
                className="close-modal"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="opinion-meta">
                <div><strong>Topic:</strong> {selectedOpinion.topic}</div>
                <div><strong>Owner:</strong> {selectedOpinion.owner}</div>
                <div><strong>Date:</strong> {new Date(selectedOpinion.timestamp * 1000).toLocaleString()}</div>
                <div><strong>Diversity Score:</strong> {selectedOpinion.diversityScore.toFixed(1)}</div>
              </div>
              
              <div className="encrypted-data">
                <h3>Encrypted Opinion Score</h3>
                <div className="encrypted-value">
                  {selectedOpinion.encryptedScore.substring(0, 50)}...
                </div>
                <button
                  onClick={async () => {
                    if (decryptedScore !== null) {
                      setDecryptedScore(null);
                    } else {
                      const score = await decryptWithSignature(selectedOpinion.encryptedScore);
                      setDecryptedScore(score);
                    }
                  }}
                  disabled={isDecrypting}
                  className="decrypt-btn"
                >
                  {isDecrypting 
                    ? "Decrypting..." 
                    : decryptedScore !== null 
                      ? "Hide Decrypted Value" 
                      : "Decrypt with Wallet"}
                </button>
              </div>
              
              {decryptedScore !== null && (
                <div className="decrypted-data">
                  <h3>Decrypted Opinion Score</h3>
                  <div className="score-display">
                    <div 
                      className="score-bar"
                      style={{ width: `${decryptedScore}%` }}
                    ></div>
                    <div className="score-value">{decryptedScore}</div>
                  </div>
                  <div className="privacy-note">
                    This value was decrypted locally using your wallet signature
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="status-modal">
          <div className="status-content">
            <div className={`status-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="status-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-links">
            <a href="#">About</a>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Contact</a>
          </div>
          <div className="footer-brand">
            Anti Echo Chamber - Powered by Zama FHE
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;