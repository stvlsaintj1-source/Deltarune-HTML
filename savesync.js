/*
 * WigdosXP Unified Save System for deltarune
 * Handles: IndexedDB ↔ localStorage ↔ WigdosXP parent frame ↔ Firebase
 */

(function() {
    'use strict';
    
    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    
    const CONFIG = {
        gameId: 'dt',
        debug: true,
        
        // IndexedDB settings
        db: {
            name: '/_savedata',
            storeName: 'FILE_DATA'
        },
        
        // localStorage prefix for save files
        localStoragePrefix: 'dt_save_',
        
        // Sync intervals
        indexedDBSyncInterval: 10000, // 10 seconds
        wigdosXPSyncInterval: 5000     // 5 seconds
    };
    
    // ============================================================================
    // LOGGING
    // ============================================================================
    
    function log(message, data = null) {
        if (CONFIG.debug) {
            console.log('[WigdosXP Unified Save]', message, data || '');
        }
    }
    
    // ============================================================================
    // GAME STARTUP MANAGEMENT
    // ============================================================================
    
    const START_MESSAGE = '✅ Save data loaded from Firestore into iframe';
    let _gameStarted = false;
    let _startAttempted = false;
    
    function _startGameOnce() {
        if (_gameStarted || _startAttempted) return;
        _startAttempted = true;
        
        log('Starting game...');
        
        // Try different possible game start functions
        const startFunctions = [
            () => typeof startGame === 'function' && startGame(),
            () => typeof GameMaker_Init === 'function' && GameMaker_Init(),
            () => typeof window.GameMaker_Init === 'function' && window.GameMaker_Init()
        ];
        
        for (const fn of startFunctions) {
            try {
                if (fn()) {
                    log('Game started successfully');
                    _gameStarted = true;
                    break;
                }
            } catch (e) {
                // Try next function
            }
        }
        
        // Set deltarune_loaded flag
        if (!localStorage.getItem('deltarune_loaded')) {
            localStorage.setItem('deltarune_loaded', 'true');
            log('Set deltarune_loaded flag');
        }
        
        _gameStarted = true;
    }
    
    function setupConsoleWrapper() {
        if (typeof console === 'undefined') return;
        
        const _orig = console.log.bind(console);
        console.log = function(...args) {
            try { _orig(...args); } catch (e) {}
            try {
                if (_gameStarted) return;
                for (const a of args) {
                    if (typeof a === 'string' && a.includes(START_MESSAGE)) {
                        log('Detected save-ready log; starting game.');
                        (async () => {
                            try { if (window.loaderReadyPromise) await window.loaderReadyPromise; } catch(e){}
                            _startGameOnce();
                        })();
                        break;
                    }
                }
            } catch (e) {}
        };
    }
    
    // ============================================================================
    // INDEXEDDB OPERATIONS
    // ============================================================================
    
    const IndexedDBSync = {
        openDB: function() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(CONFIG.db.name);
                
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(CONFIG.db.storeName)) {
                        reject(new Error(`Store ${CONFIG.db.storeName} not found`));
                        return;
                    }
                    resolve(db);
                };
            });
        },
        
        getAllFromIndexedDB: function() {
            return new Promise(async (resolve, reject) => {
                try {
                    const db = await this.openDB();
                    const transaction = db.transaction([CONFIG.db.storeName], 'readonly');
                    const store = transaction.objectStore(CONFIG.db.storeName);
                    const request = store.getAll();
                    
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                        const keysRequest = store.getAllKeys();
                        keysRequest.onsuccess = () => {
                            resolve({
                                values: request.result,
                                keys: keysRequest.result
                            });
                        };
                        keysRequest.onerror = () => reject(keysRequest.error);
                    };
                } catch (error) {
                    reject(error);
                }
            });
        },
        
        saveToIndexedDB: function(key, data) {
            return new Promise(async (resolve, reject) => {
                try {
                    const db = await this.openDB();
                    const transaction = db.transaction([CONFIG.db.storeName], 'readwrite');
                    const store = transaction.objectStore(CONFIG.db.storeName);
                    const request = store.put(data, key);
                    
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result);
                } catch (error) {
                    reject(error);
                }
            });
        },
        
        // Export IndexedDB → localStorage
        exportToLocalStorage: function() {
            return new Promise(async (resolve, reject) => {
                try {
                    const data = await this.getAllFromIndexedDB();
                    
                    if (data.keys.length === 0) {
                        log('No save data in IndexedDB to export');
                        resolve(0);
                        return;
                    }
                    
                    data.keys.forEach((key, index) => {
                        const localStorageKey = CONFIG.localStoragePrefix + key;
                        const value = data.values[index];
                        localStorage.setItem(localStorageKey, JSON.stringify(value));
                    });
                    
                    log('✓ IndexedDB → localStorage:', data.keys.length, 'files');
                    resolve(data.keys.length);
                    
                    // Notify WigdosXP that save data changed
                    WigdosXPSync.notifySaveDataChanged();
                    
                } catch (error) {
                    console.error('Error exporting to localStorage:', error);
                    reject(error);
                }
            });
        },
        
        // Import localStorage → IndexedDB
        importFromLocalStorage: function() {
            return new Promise(async (resolve, reject) => {
                try {
                    let importCount = 0;
                    const promises = [];
                    
                    for (let i = 0; i < localStorage.length; i++) {
                        const localKey = localStorage.key(i);
                        
                        if (localKey && localKey.startsWith(CONFIG.localStoragePrefix)) {
                            const indexedDBKey = localKey.substring(CONFIG.localStoragePrefix.length);
                            const dataString = localStorage.getItem(localKey);
                            
                            try {
                                const data = JSON.parse(dataString);
                                
                                promises.push(
                                    this.saveToIndexedDB(indexedDBKey, data).then(() => {
                                        importCount++;
                                        log('✓ Restored to IndexedDB:', indexedDBKey);
                                    })
                                );
                            } catch (parseError) {
                                console.error('Parse error for key:', localKey, parseError);
                            }
                        }
                    }
                    
                    await Promise.all(promises);
                    
                    if (importCount > 0) {
                        log('✓ localStorage → IndexedDB:', importCount, 'files');
                    }
                    
                    resolve(importCount);
                } catch (error) {
                    console.error('Error importing from localStorage:', error);
                    reject(error);
                }
            });
        },
        
        initialize: function() {
            log('Initializing IndexedDB sync...');
            
            this.importFromLocalStorage()
                .then(() => {
                    return this.exportToLocalStorage();
                })
                .then(() => {
                    log('✓ IndexedDB sync initialized');
                    
                    // Periodic IndexedDB → localStorage sync
                    setInterval(() => {
                        this.exportToLocalStorage().catch(err => {
                            console.error('Periodic IndexedDB sync failed:', err);
                        });
                    }, CONFIG.indexedDBSyncInterval);
                })
                .catch(error => {
                    console.error('IndexedDB sync initialization failed:', error);
                });
        }
    };
    
    // ============================================================================
    // WIGDOSXP PARENT FRAME COMMUNICATION
    // ============================================================================
    
    const WigdosXPSync = {
        isInIframe: window.parent !== window,
        lastSyncedData: null,
        
        // Send all localStorage to WigdosXP parent
        notifySaveDataChanged: function() {
            if (!this.isInIframe) return;
            
            try {
                const allLocalStorageData = {};
                
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    allLocalStorageData[key] = localStorage.getItem(key);
                }
                
                // Only send if data actually changed
                const dataString = JSON.stringify(allLocalStorageData);
                if (dataString === this.lastSyncedData) {
                    return;
                }
                this.lastSyncedData = dataString;
                
                window.parent.postMessage({
                    type: 'saveDataChanged',
                    gameId: CONFIG.gameId,
                    allLocalStorageData: allLocalStorageData
                }, '*');
                
                log('✓ localStorage → WigdosXP parent frame');
                
            } catch (error) {
                console.error('Error notifying WigdosXP:', error);
            }
        },
        
        // Request initial save data from WigdosXP
        requestInitialSaveData: function() {
            if (!this.isInIframe) return;
            
            const messageId = `initial_load_${Date.now()}`;
            
            log('Requesting initial save data from WigdosXP...');
            
            const timeout = setTimeout(() => {
                log('Timeout waiting for initial save data');
            }, 5000);
            
            const responseHandler = function(event) {
                if (event.data && event.data.type === 'initialSaveDataResponse' && event.data.messageId === messageId) {
                    clearTimeout(timeout);
                    window.removeEventListener('message', responseHandler);
                    
                    log('Received initial save data from WigdosXP');
                    
                    if (event.data.allLocalStorageData && Object.keys(event.data.allLocalStorageData).length > 0) {
                        log('Loading initial save data:', Object.keys(event.data.allLocalStorageData).length, 'items');
                        
                        // Load into localStorage
                        Object.keys(event.data.allLocalStorageData).forEach(key => {
                            localStorage.setItem(key, event.data.allLocalStorageData[key]);
                        });
                        
                        // Then sync to IndexedDB
                        IndexedDBSync.importFromLocalStorage().then(() => {
                            log('✓ WigdosXP → localStorage → IndexedDB complete');
                            
                            // Start game after save data is loaded
                            setTimeout(() => {
                                log('Save data loaded; starting game.');
                                (async () => {
                                    try { if (window.loaderReadyPromise) await window.loaderReadyPromise; } catch(e){}
                                    _startGameOnce();
                                })();
                            }, 500);
                        });
                        
                        window.dispatchEvent(new CustomEvent('wigdosxp-save-loaded', {
                            detail: {
                                gameId: CONFIG.gameId,
                                data: event.data.allLocalStorageData,
                                isInitialLoad: true
                            }
                        }));
                    }
                }
            };
            
            window.addEventListener('message', responseHandler);
            
            window.parent.postMessage({
                type: 'getInitialSaveData',
                gameId: CONFIG.gameId,
                messageId: messageId
            }, '*');
        },
        
        // Handle messages from WigdosXP parent
        setupMessageListeners: function() {
            if (!this.isInIframe) return;
            
            window.addEventListener('message', function(event) {
                if (window.parent === window || !event.data || !event.data.type) return;
                
                log('Received message from WigdosXP:', event.data.type);
                
                switch (event.data.type) {
                    case 'getAllLocalStorageData':
                        WigdosXPSync.handleGetAllLocalStorageData(event);
                        break;
                        
                    case 'setAllLocalStorageData':
                        WigdosXPSync.handleSetAllLocalStorageData(event);
                        break;
                        
                    case 'requestSnapshot':
                        WigdosXPSync.handleSnapshotRequest(event);
                        break;
                }
            });
        },
        
        handleGetAllLocalStorageData: function(event) {
            try {
                const allLocalStorageData = {};
                
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    allLocalStorageData[key] = localStorage.getItem(key);
                }
                
                event.source.postMessage({
                    type: 'saveDataResponse',
                    messageId: event.data.messageId,
                    allLocalStorageData: allLocalStorageData
                }, event.origin);
                
                log('✓ Sent save data to WigdosXP');
                
            } catch (error) {
                console.error('Error getting localStorage:', error);
                event.source.postMessage({
                    type: 'saveDataResponse',
                    messageId: event.data.messageId,
                    allLocalStorageData: null,
                    error: error.message
                }, event.origin);
            }
        },
        
        handleSetAllLocalStorageData: function(event) {
            try {
                if (event.data.allLocalStorageData) {
                    log('Restoring save data from WigdosXP:', Object.keys(event.data.allLocalStorageData).length, 'items');
                    
                    // Clear and restore localStorage
                    localStorage.clear();
                    
                    Object.keys(event.data.allLocalStorageData).forEach(key => {
                        localStorage.setItem(key, event.data.allLocalStorageData[key]);
                    });
                    
                    // Sync to IndexedDB
                    IndexedDBSync.importFromLocalStorage().then(() => {
                        log('✓ WigdosXP → localStorage → IndexedDB complete');
                        
                        // Send success response
                        event.source.postMessage({
                            type: 'loadDataResponse',
                            messageId: event.data.messageId,
                            success: true
                        }, event.origin);
                        
                        // Reload page to apply save data
                        log('Reloading page to apply save data...');
                        setTimeout(() => {
                            window.location.reload();
                        }, 100);
                    });
                    
                    window.dispatchEvent(new CustomEvent('wigdosxp-save-loaded', {
                        detail: {
                            gameId: CONFIG.gameId,
                            data: event.data.allLocalStorageData
                        }
                    }));
                }
                
            } catch (error) {
                console.error('Error setting localStorage:', error);
                event.source.postMessage({
                    type: 'loadDataResponse',
                    messageId: event.data.messageId,
                    success: false,
                    error: error.message
                }, event.origin);
            }
        },
        
        handleSnapshotRequest: function(event) {
            try {
                if (typeof html2canvas !== 'undefined') {
                    html2canvas(document.body, {
                        width: 240,
                        height: 140,
                        scale: 0.3
                    }).then(canvas => {
                        event.source.postMessage({
                            type: 'snapshotResponse',
                            messageId: event.data.messageId,
                            dataUrl: canvas.toDataURL('image/png')
                        }, event.origin);
                        log('✓ Sent snapshot to WigdosXP');
                    }).catch(err => {
                        log('Snapshot capture failed:', err);
                        event.source.postMessage({
                            type: 'snapshotResponse',
                            messageId: event.data.messageId,
                            dataUrl: null
                        }, event.origin);
                    });
                } else {
                    event.source.postMessage({
                        type: 'snapshotResponse',
                        messageId: event.data.messageId,
                        dataUrl: null
                    }, event.origin);
                }
            } catch (error) {
                console.error('Error handling snapshot:', error);
            }
        },
        
        sendReadySignal: function() {
            if (!this.isInIframe) return;
            
            setTimeout(() => {
                window.parent.postMessage({
                    type: 'wigdosxp-integration-ready',
                    gameId: CONFIG.gameId
                }, '*');
                log('✓ Sent ready signal to WigdosXP');
            }, 1000);
        },
        
        initialize: function() {
            if (!this.isInIframe) {
                log('Running standalone - WigdosXP sync disabled');
                return;
            }
            
            log('Initializing WigdosXP sync...');
            this.requestInitialSaveData();
            this.setupMessageListeners();
            this.sendReadySignal();
            
            // Periodic localStorage → WigdosXP sync
            setInterval(() => {
                this.notifySaveDataChanged();
            }, CONFIG.wigdosXPSyncInterval);
        }
    };
    
    // ============================================================================
    // INITIALIZATION
    // ============================================================================
    
    log('WigdosXP Unified Save System starting...');
    
    // Set up console wrapper to detect game ready
    setupConsoleWrapper();
    
    // Wait for IndexedDB to be created by the game
    window.addEventListener('load', function() {
        let attempts = 0;
        const maxAttempts = 20;
        
        function tryInitialize() {
            attempts++;
            
            IndexedDBSync.openDB()
                .then(() => {
                    log('✓ IndexedDB found, initializing...');
                    
                    // Initialize IndexedDB sync first
                    IndexedDBSync.initialize();
                    
                    // Then initialize WigdosXP sync
                    WigdosXPSync.initialize();
                    
                    log('✓ Unified save system initialized');
                })
                .catch(error => {
                    if (attempts < maxAttempts) {
                        log(`Waiting for IndexedDB... (${attempts}/${maxAttempts})`);
                        setTimeout(tryInitialize, 1500);
                    } else {
                        console.error('IndexedDB not found after', maxAttempts, 'attempts');
                        console.error('Last error:', error.message);
                        
                        // Still initialize WigdosXP sync even if IndexedDB fails
                        WigdosXPSync.initialize();
                    }
                });
        }
        
        // Start trying after 3 seconds
        setTimeout(tryInitialize, 3000);
    });
    
    // Fallback game start timeout
    setTimeout(() => {
        if (!_gameStarted) {
            log('Timeout reached; starting game as fallback.');
            (async () => {
                try { if (window.loaderReadyPromise) await window.loaderReadyPromise; } catch(e){}
                _startGameOnce();
            })();
        }
    }, WigdosXPSync.isInIframe ? 2000 : 1000);
    
    log('✓ Unified save system ready');
    
})();