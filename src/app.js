import {
    buildStatePatchForDataSourceSelection,
    isDataSourceSidebarActive,
} from './state-transitions.mjs';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// State management
let state = {
    dataSources: [],
    selectedSource: null,
    currentPath: '',
    files: [],
    bucketTotalSize: 0, // 桶总存储大小 (s3cmd du)
    loading: false,
    loadingMore: false, // 加载更多状态
    continuationToken: null, // 分页令牌
    hasMore: false, // 是否有更多数据
    showAddModal: false,
    editingSource: null, // 正在编辑的数据源
    showNewFolderModal: false,
    newFolderTargetPath: null,
    showDeleteConfirm: false,
    deleteTarget: null,
    showRenameModal: false,
    renameTarget: null,
    searchQuery: '',
    isSearching: false,  // 是否正在搜索模式
    searchResults: [],    // 搜索结果
    contextMenu: { visible: false, x: 0, y: 0, target: null, type: 'file' },
    theme: 'light',
    viewMode: 'list', // 'list' or 'tree'
    expandedFolders: {}, // 用于树状结构展开状态
    toast: null, // { message: string, type: 'success' | 'error', visible: boolean }
    preview: null, // { visible: boolean, type: 'image' | 'text' | null, key: string, url: string, content: string }
    dragOver: false, // 是否正在拖拽（外部文件）
    dragTarget: null, // 拖拽目标文件夹
    activePage: 'objects', // 'objects' | 'transfers'
    transfers: [], // 上传/下载历史记录
};

// 拖拽状态管理（全局，不通过 state）
let dragState = {
    sourceKey: null,  // 正在拖拽的源文件/文件夹 key
    targetKey: null,  // 当前悬停的目标文件夹 key
};

let dragDropUnlisten = null;

function getFileNameFromPath(filePath) {
    if (!filePath) return '';
    const cleanPath = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
    return cleanPath.split(/[/\\]/).pop();
}

const WARMUP_MAX_CONNECTIONS = 3;
const RECENT_SOURCES_KEY = 's3-explorer-recent-sources';
const TRANSFER_HISTORY_KEY = 's3-explorer-transfer-history';
const MAX_TRANSFER_HISTORY = 200;

function getRecentSourceIds() {
    try {
        const raw = localStorage.getItem(RECENT_SOURCES_KEY);
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function recordRecentSource(id) {
    if (!id) return;
    const recent = getRecentSourceIds().filter(x => x !== id);
    recent.unshift(id);
    localStorage.setItem(RECENT_SOURCES_KEY, JSON.stringify(recent.slice(0, 10)));
}

function orderSourcesForWarmup(sources) {
    const recent = new Set(getRecentSourceIds());
    const byId = new Map(sources.map(s => [s.id, s]));
    const ordered = [];
    
    getRecentSourceIds().forEach(id => {
        const source = byId.get(id);
        if (source) ordered.push(source);
    });
    
    sources.forEach(source => {
        if (!recent.has(source.id)) ordered.push(source);
    });
    
    return ordered;
}

function loadTransferHistory() {
    try {
        const raw = localStorage.getItem(TRANSFER_HISTORY_KEY);
        const parsed = JSON.parse(raw || '[]');
        if (Array.isArray(parsed)) {
            state.transfers = parsed.slice(0, MAX_TRANSFER_HISTORY);
        }
    } catch {
        state.transfers = [];
    }
}

function saveTransferHistory() {
    try {
        localStorage.setItem(
            TRANSFER_HISTORY_KEY,
            JSON.stringify(state.transfers.slice(0, MAX_TRANSFER_HISTORY))
        );
    } catch {
        // ignore storage errors
    }
}

function ensureTransferRecord(id, defaults = {}) {
    let transfer = state.transfers.find(t => t.id === id);
    if (!transfer) {
        transfer = {
            id,
            direction: defaults.direction || 'upload',
            key: defaults.key || '',
            total: defaults.total ?? null,
            transferred: 0,
            status: defaults.status || 'queued',
            sourceId: defaults.sourceId || null,
            sourceName: defaults.sourceName || '',
            bucket: defaults.bucket || '',
            startedAt: defaults.startedAt || Date.now(),
            endedAt: null,
            lastUpdateAt: null,
            lastBytes: 0,
            speed: 0,
            speedSampleAt: null,
            speedSampleBytes: 0,
            error: null,
        };
        state.transfers.unshift(transfer);
        state.transfers = state.transfers.slice(0, MAX_TRANSFER_HISTORY);
    }
    return transfer;
}

function updateTransferFromEvent(payload) {
    if (!payload?.id) return;
    const transfer = ensureTransferRecord(payload.id, {
        direction: payload.direction,
        key: payload.key,
        status: payload.status === 'started' ? 'in_progress' : payload.status,
    });
    const now = Date.now();
    if (payload.total !== undefined && payload.total !== null) {
        transfer.total = payload.total;
    }
    if (payload.bytes !== undefined && payload.bytes !== null) {
        const nextBytes = Math.max(payload.bytes, transfer.transferred || 0);
        transfer.transferred = nextBytes;
        transfer.lastBytes = nextBytes;

        if (!transfer.speedSampleAt) {
            transfer.speedSampleAt = now;
            transfer.speedSampleBytes = nextBytes;
        } else {
            const sampleElapsedMs = now - transfer.speedSampleAt;
            if (sampleElapsedMs >= 1000) {
                const sampleBytes = nextBytes - (transfer.speedSampleBytes || 0);
                if (sampleBytes > 0) {
                    transfer.speed = sampleBytes / (sampleElapsedMs / 1000);
                }
                transfer.speedSampleAt = now;
                transfer.speedSampleBytes = nextBytes;
            }
        }
    }
    transfer.lastUpdateAt = now;
    if (payload.status) {
        if (payload.status === 'started') {
            transfer.status = 'in_progress';
        } else if (payload.status === 'progress') {
            transfer.status = 'in_progress';
        } else if (payload.status === 'paused') {
            transfer.status = 'paused';
        } else if (payload.status === 'resumed') {
            transfer.status = 'in_progress';
        } else {
            transfer.status = payload.status;
        }
    }
    if (payload.message) {
        transfer.error = payload.message;
    }
    if (payload.status === 'completed' || payload.status === 'failed') {
        if (payload.status === 'completed' && transfer.total && transfer.transferred < transfer.total) {
            transfer.transferred = transfer.total;
        }
        transfer.endedAt = now;
    }
    saveTransferHistory();
}

function createTransferRecord({ id, direction, key, total, sourceId, sourceName, bucket }) {
    const transfer = ensureTransferRecord(id, {
        direction,
        key,
        total,
        sourceId,
        sourceName,
        bucket,
        status: 'queued',
        startedAt: Date.now(),
    });
    saveTransferHistory();
    return transfer;
}

function clearTransferHistory() {
    state.transfers = [];
    saveTransferHistory();
    renderApp();
}

function deleteTransferRecord(id) {
    state.transfers = state.transfers.filter(t => t.id !== id);
    saveTransferHistory();
    renderApp();
}

async function toggleTransferPause(id) {
    const transfer = state.transfers.find(t => t.id === id);
    if (!transfer) return;
    try {
        if (transfer.status === 'paused') {
            await invoke('resume_transfer', { transferId: id });
        } else {
            await invoke('pause_transfer', { transferId: id });
        }
    } catch (error) {
        console.error('Failed to toggle transfer pause', error);
        showToast(`操作失败: ${error}`, 'error');
    }
}

function createTransferId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// 文件类型定义
const FILE_TYPES = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'],
    text: ['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'log', 'conf', 'config', 'ini', 'properties', 'sql', 'dockerfile', 'makefile'],
};

// 判断文件类型
function getFileType(key) {
    const ext = key.split('.').pop().toLowerCase();
    if (FILE_TYPES.image.includes(ext)) return 'image';
    if (FILE_TYPES.text.includes(ext)) return 'text';
    return 'other';
}

// 判断是否是图片
function isImageFile(key) {
    return getFileType(key) === 'image';
}

// 判断是否是文本文件
function isTextFile(key) {
    return getFileType(key) === 'text';
}

// AWS Regions
const AWS_REGIONS = [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'af-south-1',
    'ap-east-1',
    'ap-south-1',
    'ap-northeast-3',
    'ap-northeast-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    'eu-central-1',
    'eu-west-1',
    'eu-west-2',
    'eu-south-1',
    'eu-west-3',
    'eu-north-1',
    'me-south-1',
    'sa-east-1',
];

// Utility functions
function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now - date;
        
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
        
        return date.toLocaleDateString();
    } catch {
        return dateStr;
    }
}

function formatTime(timestamp) {
    if (!timestamp) return '—';
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp);
    }
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
    return `${formatFileSize(bytesPerSec)}/s`;
}

function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '—';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function getFileIcon(filename) {
    if (!filename) return 'default';

    if (filename.endsWith('.tar.gz')) {
        return 'tar.gz';
    }

    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        json: 'json',
        csv: 'csv',
        md: 'md',
        zip: 'zip',
        folder: 'folder',
        png: 'png',
        yaml: 'yaml',
        yml: 'yaml',
        py: 'py',
        tar: 'tar',
        sql: 'sql',
        // 文档类型
        pdf: 'pdf',
        doc: 'word',
        docx: 'word',
        xls: 'excel',
        xlsx: 'excel',
        ppt: 'ppt',
        pptx: 'ppt',
        rtf: 'doc',
        odt: 'word',
        ods: 'excel',
        odp: 'ppt',
    };
    return iconMap[ext] || 'default';
}

function getFileName(key) {
    if (!key) return '';
    const cleanKey = key.endsWith('/') ? key.slice(0, -1) : key;
    return cleanKey.split('/').pop();
}

// UI Rendering Functions
function renderApp() {
    const app = document.getElementById('app');
    const fileTable = document.querySelector('.file-table');
    const dataSources = document.querySelector('.data-sources');
    
    const scrollBefore = {
        fileTable: fileTable ? fileTable.scrollTop : 0,
        dataSources: dataSources ? dataSources.scrollTop : 0
    };
    
    app.innerHTML = `
        ${renderSidebar()}
        ${renderMainContent()}
        ${state.showAddModal ? renderAddModal() : ''}
        ${state.showNewFolderModal ? renderNewFolderModal() : ''}
        ${state.showDeleteConfirm ? renderDeleteConfirmModal() : ''}
        ${state.showRenameModal ? renderRenameModal() : ''}
        ${state.contextMenu.visible ? renderContextMenu() : ''}
        ${state.toast ? renderToast() : ''}
        ${state.preview?.visible ? renderPreviewModal() : ''}
    `;
    
    // 如果显示的是数据源上下文菜单，单独渲染
    if (state.dataSourceContextMenu?.visible) {
        const menu = document.createElement('div');
        menu.innerHTML = renderDataSourceContextMenu();
        app.appendChild(menu.firstElementChild);
    }
    
    const restoreScroll = () => {
        const newFileTable = document.querySelector('.file-table');
        const newDataSources = document.querySelector('.data-sources');
        
        if (newFileTable) newFileTable.scrollTop = scrollBefore.fileTable;
        if (newDataSources) newDataSources.scrollTop = scrollBefore.dataSources;
    };
    
    restoreScroll();
    setTimeout(restoreScroll, 0);
    setTimeout(restoreScroll, 50);
    
    attachEventListeners();
}

function setActivePage(page) {
    state.activePage = page;
    renderApp();
}

function renderSidebar() {
    return `
        <div class="sidebar">
            <div class="sidebar-header">
                <h1 onclick="setActivePage('objects')">S3</h1>
            </div>
            <div class="sidebar-nav-group">
                <button type="button" class="sidebar-nav-item ${state.activePage === 'transfers' ? 'active' : ''}" onclick="setActivePage('transfers')">
                    ⏱ 传输记录
                </button>
            </div>
            <button type="button" class="add-source-btn" onclick="showAddModal()">+ 添加数据源</button>
            <div class="data-sources">
                <div class="data-sources-header">
                    <span>数据源</span>
                    ${state.activePage === 'transfers' ? '<span class="data-sources-hint">传输记录是全局视图</span>' : ''}
                </div>
                ${state.dataSources.map(source => `
                    <div class="data-source-item ${isDataSourceSidebarActive({
                        activePage: state.activePage,
                        sourceId: source.id,
                        selectedSourceId: state.selectedSource?.id,
                    }) ? 'active' : ''}" 
                         onclick="selectDataSource('${source.id}')"
                         oncontextmenu="showDataSourceContextMenu(event, '${source.id}')">
                        <div class="data-source-icon">☁️</div>
                        <div class="data-source-info">
                            <div class="data-source-name">${escapeHtml(source.name)}</div>
                            <div class="data-source-bucket">${escapeHtml(source.bucket)}</div>
                            <div class="data-source-endpoint" title="${escapeHtml(source.endpoint)}">${escapeHtml(source.endpoint)}</div>
                        </div>
                        <div class="data-source-actions">
                            <button type="button" class="data-source-action-btn" onclick="event.stopPropagation(); editDataSource('${source.id}')" title="编辑">✏️</button>
                            <button type="button" class="data-source-action-btn delete" onclick="event.stopPropagation(); deleteDataSource('${source.id}')" title="删除">🗑️</button>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="sidebar-footer">
                ${state.activePage === 'transfers' ? `
                    <div class="sidebar-footer-bucket">全局传输记录</div>
                    <div class="sidebar-footer-size">显示所有数据源的上传与下载任务</div>
                ` : state.selectedSource ? `
                    <div class="sidebar-footer-bucket">${escapeHtml(state.selectedSource.bucket)}</div>
                    <div class="sidebar-footer-size" title="桶总存储">${formatFileSize(state.bucketTotalSize)}</div>
                ` : '请选择一个数据源'}
            </div>
        </div>
    `;
}

function renderMainContent() {
    if (state.activePage === 'transfers') {
        return renderTransfersView();
    }
    if (!state.selectedSource) {
        return `
            <div class="main-content">
                <div class="empty-state">
                    <div class="empty-state-icon">☁️</div>
                    <h3>未选择数据源</h3>
                    <p>添加一个数据源以开始使用</p>
                </div>
            </div>
        `;
    }
    
    return `
        <div class="main-content">
            <div class="toolbar">
                <div class="view-toggle">
                    <button type="button" class="view-toggle-btn ${state.viewMode === 'list' ? 'active' : ''}" onclick="toggleViewMode('list')">
                        <span class="view-toggle-icon">☰</span>
                        <span class="view-toggle-text">列表</span>
                    </button>
                    <button type="button" class="view-toggle-btn ${state.viewMode === 'tree' ? 'active' : ''}" onclick="toggleViewMode('tree')">
                        <span class="view-toggle-icon">🌳</span>
                        <span class="view-toggle-text">树状</span>
                    </button>
                </div>
                <div class="search-box">
                    <div class="search-input-wrapper">
                        <input type="text" 
                               id="search-input"
                               placeholder="搜索桶中所有对象..." 
                               value="${escapeHtml(state.searchQuery)}"
                               onkeydown="if(event.key==='Enter') handleSearchSubmit()"
                               onmousedown="event.stopPropagation()">
                        ${state.searchQuery ? `
                        <button type="button" class="search-clear-btn-inline" onclick="clearSearch()" title="清除搜索">✕</button>
                        ` : ''}
                    </div>
                    <button type="button" class="search-btn" onclick="handleSearchSubmit()" title="查询">
                        🔍
                    </button>
                </div>
                <div class="toolbar-actions">
                    <button type="button" class="toolbar-btn" onclick="handleRefresh()">
                        🔄 刷新
                    </button>
                    <button type="button" class="toolbar-btn" onclick="handleNewFolder()">
                        📁 新建文件夹
                    </button>
                    <button type="button" class="toolbar-btn" onclick="handleUpload()">
                        ⬆️ 上传
                    </button>
                </div>
            </div>
            <div class="breadcrumb">
                <button type="button" class="breadcrumb-home-btn" onclick="handleGoHome()" title="返回首页">🏠 首页</button>
                ${state.currentPath ? `
                    <button type="button" class="breadcrumb-back-btn" onclick="handleGoUp()" title="返回上级">⬆️ 返回</button>
                    <span class="breadcrumb-path">${escapeHtml(state.currentPath)}</span>
                ` : `<span class="breadcrumb-path">${escapeHtml(state.selectedSource.bucket)}</span>`}
            </div>
            <div class="file-list-container">
                ${state.loading ? renderLoading() : (state.isSearching ? renderSearchResults() : (state.viewMode === 'tree' ? renderFileTree() : renderFileTable()))}
            </div>
        </div>
    `;
}

function getTransferPercent(transfer) {
    if (!transfer || !transfer.total) return transfer?.status === 'completed' ? 100 : 0;
    return Math.min(100, Math.floor((transfer.transferred / transfer.total) * 100));
}

function getTransferStatusLabel(status) {
    switch (status) {
        case 'completed':
            return '已完成';
        case 'failed':
            return '失败';
        case 'paused':
            return '已暂停';
        case 'in_progress':
            return '进行中';
        case 'queued':
            return '排队中';
        default:
            return status || '—';
    }
}

function renderTransfersView() {
    const transfers = state.transfers || [];
    if (transfers.length === 0) {
        return `
            <div class="main-content">
                <div class="empty-state">
                    <div class="empty-state-icon">⏱</div>
                    <h3>暂无传输记录</h3>
                    <p>上传或下载文件后会显示进度与历史</p>
                </div>
            </div>
        `;
    }
    return `
        <div class="main-content">
            <div class="toolbar transfers-toolbar">
                <div class="toolbar-title">传输记录</div>
                <div class="toolbar-actions">
                    <button type="button" class="toolbar-btn" onclick="setActivePage('objects')">
                        ← 返回对象
                    </button>
                    <button type="button" class="toolbar-btn" onclick="clearTransferHistory()">
                        🧹 清空历史
                    </button>
                </div>
            </div>
            <div class="transfer-list">
                ${transfers.map(transfer => {
                    const percent = getTransferPercent(transfer);
                    const name = getFileName(transfer.key) || transfer.key || '—';
                    const directionLabel = transfer.direction === 'download' ? '下载' : '上传';
                    const remaining = transfer.total && transfer.speed
                        ? formatDuration((transfer.total - transfer.transferred) / transfer.speed)
                        : '—';
                    const statusClass = transfer.status || 'queued';
                    const progressText = transfer.total
                        ? `${percent}% (${formatFileSize(transfer.transferred)} / ${formatFileSize(transfer.total)})`
                        : `${formatFileSize(transfer.transferred)}`;
                    const isActive = transfer.status === 'in_progress' || transfer.status === 'paused';
                    return `
                        <div class="transfer-row ${statusClass}">
                            <div class="transfer-main">
                                <div class="transfer-name">${escapeHtml(name)}</div>
                                <div class="transfer-meta">${directionLabel} · ${escapeHtml(transfer.key || '')}</div>
                            </div>
                            <div class="transfer-progress">
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percent}%"></div>
                                </div>
                                <div class="progress-text">${progressText}</div>
                            </div>
                            <div class="transfer-stats">
                                <div class="transfer-speed">${formatSpeed(transfer.speed)}</div>
                                <div class="transfer-eta">${remaining}</div>
                            </div>
                            <div class="transfer-status ${statusClass}">
                                ${getTransferStatusLabel(transfer.status)}
                            </div>
                            <div class="transfer-actions">
                                ${isActive ? `
                                    <button type="button" class="transfer-action-btn" onclick="toggleTransferPause('${transfer.id}')">
                                        ${transfer.status === 'paused' ? '继续' : '暂停'}
                                    </button>
                                ` : ''}
                                <button type="button" class="transfer-action-btn danger" onclick="deleteTransferRecord('${transfer.id}')">
                                    删除
                                </button>
                                <div class="transfer-time">${formatTime(transfer.startedAt)}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderLoading() {
    return `
        <div class="loading-container">
            <div class="loading-spinner"></div>
            <div class="loading-text">正在加载对象列表...</div>
            <div class="loading-subtext">首次加载可能需要一些时间</div>
        </div>
    `;
}

function renderFileTable() {
    const files = state.files;
    
    if (files.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <h3>没有找到文件</h3>
                <p>上传文件或创建文件夹</p>
            </div>
        `;
    }
    
    return `
        <div class="file-table ${state.dragOver ? 'drag-over' : ''}"
             ondragenter="handleDragEnter(event)"
             ondragover="handleDragOver(event)"
             ondragleave="handleDragLeave(event)"
             ondrop="handleDrop(event)">
            <table>
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>大小</th>
                        <th>修改时间</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${files.map(file => `
                        <tr draggable="true" 
                            ondragstart="handleItemDragStart(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')"
                            ondragend="handleItemDragEnd(event)"
                            ${file.is_folder ? `ondragenter="handleItemDragEnter(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')" ondragleave="handleItemDragLeave(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')" ondrop="handleItemDrop(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')" ondragover="handleItemDragOver(event)" class="folder-row"` : `class="file-row"`}
                            onclick="event.preventDefault(); ${file.is_folder ? `navigateToFolder('${escapeHtml(file.key)}')` : `handleFileClick('${escapeHtml(file.key.replace(/'/g, "\\'"))}')`}" 
                            oncontextmenu="showContextMenu(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')"
                            style="cursor: pointer;">
                            <td>
                                <div class="file-name" draggable="true"
                                     ondragstart="handleItemDragStart(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')"
                                     ondragend="handleItemDragEnd(event)">
                                    <div class="file-icon ${file.is_folder ? 'folder' : getFileIcon(file.key)}">
                                        ${file.is_folder ? '📁' : getFileIcon(file.key) === 'json' ? '{}' : 
                                          getFileIcon(file.key) === 'csv' ? '📊' : 
                                          getFileIcon(file.key) === 'md' ? '📄' : 
                                          getFileIcon(file.key) === 'zip' ? '📦' :
                                          getFileIcon(file.key) === 'png' ? '🖼️' :
                                          getFileIcon(file.key) === 'yaml' ? 'YAML' :
                                          getFileIcon(file.key) === 'sql' ? 'SQL' :
                                          getFileIcon(file.key) === 'py' ? '🐍' :
                                          getFileIcon(file.key) === 'tar' ? '📦' :
                                          getFileIcon(file.key) === 'tar.gz' ? '📦' :
                                          getFileIcon(file.key) === 'pdf' ? 'PDF' :
                                          getFileIcon(file.key) === 'word' ? '📘' :
                                          getFileIcon(file.key) === 'excel' ? '📗' :
                                          getFileIcon(file.key) === 'ppt' ? '📙' :
                                          getFileIcon(file.key) === 'doc' ? '📄' :
                                          '📄'}
                                    </div>
                                    <span>${escapeHtml(getFileName(file.key))}</span>
                                </div>
                            </td>
                            <td class="file-size">${formatFileSize(file.size)}</td>
                            <td class="file-modified">${formatDate(file.last_modified)}</td>
                            <td class="file-actions">
                                <button type="button" class="action-btn" onclick="event.stopPropagation(); handleFileAction('${escapeHtml(file.key)}', 'more')">⋯</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ${renderLoadMoreButton()}
        </div>
    `;
}

function renderLoadMoreButton() {
    const showLoadMore = state.hasMore || state.loadingMore;
    
    return `
        <div class="load-more-container">
            ${showLoadMore ? `
                <button type="button" 
                        class="load-more-btn ${state.loadingMore ? 'loading' : ''}"
                        onclick="loadMoreObjects()"
                        ${state.loadingMore ? 'disabled' : ''}>
                    ${state.loadingMore ? '加载中...' : '加载更多'}
                </button>
            ` : ''}
            <button type="button" 
                    class="back-to-top-btn"
                    onclick="scrollToTop()">
                返回顶部
            </button>
            <span class="load-more-hint">已加载 ${state.files.length} 个对象</span>
        </div>
    `;
}

// 构建树状结构数据
function buildTreeData(files) {
    const root = { name: '', key: '', is_folder: true, children: [] };
    
    files.forEach(file => {
        const parts = file.key.split('/').filter(p => p);
        let current = root;
        
        parts.forEach((part, index) => {
            const isLast = index === parts.length - 1;
            const currentKey = parts.slice(0, index + 1).join('/') + (isLast && file.is_folder ? '/' : '');
            
            let existing = current.children.find(c => c.name === part);
            if (!existing) {
                existing = {
                    name: part,
                    key: currentKey,
                    is_folder: file.is_folder || !isLast,
                    size: isLast ? file.size : null,
                    last_modified: isLast ? file.last_modified : null,
                    children: [],
                };
                current.children.push(existing);
            }
            current = existing;
        });
    });
    
    // 按文件夹优先排序
    const sortChildren = (node) => {
        node.children.sort((a, b) => {
            if (a.is_folder === b.is_folder) {
                return a.name.localeCompare(b.name);
            }
            return a.is_folder ? -1 : 1;
        });
        node.children.forEach(sortChildren);
    };
    sortChildren(root);
    
    return root;
}

// 渲染树状结构
function renderFileTree() {
    const files = state.files;
    
    if (files.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <h3>没有找到文件</h3>
                <p>上传文件或创建文件夹</p>
            </div>
        `;
    }
    
    const treeData = buildTreeData(files);
    
    return `
        <div class="file-tree ${state.dragOver ? 'drag-over' : ''}"
             ondragenter="handleDragEnter(event)"
             ondragover="handleDragOver(event)"
             ondragleave="handleDragLeave(event)"
             ondrop="handleDrop(event)">
            <div class="tree-header">
                <div class="tree-header-spacer"></div>
                <span>名称</span>
                <span>大小</span>
                <span>修改时间</span>
            </div>
            <div class="tree-content">
                ${renderTreeNode(treeData, 0, '')}
            </div>
        </div>
    `;
}

// 递归渲染树节点
function renderTreeNode(node, level, parentPath) {
    if (level === 0) {
        // 根节点只渲染子节点
        return node.children.map(child => renderTreeNode(child, 1, '')).join('');
    }
    
    const isExpanded = state.expandedFolders[node.key] === true; // 默认收起
    const hasChildren = node.children && node.children.length > 0;
    const indent = level * 16;
    const displayName = node.name || state.selectedSource?.bucket || 'Root';
    
    // 文件夹：展开按钮 + 图标名称区（可点击进入）+ 大小 + 时间
    // 文件：占位 + 图标名称区 + 大小 + 时间
    const clickAction = node.is_folder 
        ? `onclick="navigateToFolder('${escapeHtml(node.key.replace(/'/g, "\\'"))}')"`
        : `onclick="handleFileClick('${escapeHtml(node.key.replace(/'/g, "\\'"))}')"`;
    
    const dragAttrs = node.is_folder 
        ? `draggable="true" ondragstart="handleItemDragStart(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')" ondragend="handleItemDragEnd(event)" ondragenter="handleItemDragEnter(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')" ondragleave="handleItemDragLeave(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')" ondrop="handleItemDrop(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')" ondragover="handleItemDragOver(event)" class="tree-row ${node.is_folder ? 'folder' : 'file'}"`
        : `draggable="true" ondragstart="handleItemDragStart(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')" ondragend="handleItemDragEnd(event)" class="tree-row ${node.is_folder ? 'folder' : 'file'}"`;
    
    let html = `
        <div class="tree-node" style="padding-left: ${indent}px">
            <div ${dragAttrs}
                 oncontextmenu="showContextMenu(event, '${escapeHtml(node.key.replace(/'/g, "\\'"))}')">
                ${node.is_folder ? `
                    <button type="button" 
                            class="tree-expander-btn"
                            onclick="event.stopPropagation(); toggleFolder('${escapeHtml(node.key.replace(/'/g, "\\'"))}')"
                            title="${isExpanded ? '收起' : '展开'}">
                        ${isExpanded ? '−' : '+'}
                    </button>
                ` : '<div class="tree-expander-placeholder"></div>'}
                <div class="tree-content-area" ${clickAction}>
                    <div class="tree-icon ${node.is_folder ? 'folder' : getFileIcon(node.key)}">
                        ${node.is_folder ? (isExpanded ? '📂' : '📁') : 
                          getFileIcon(node.key) === 'json' ? '{}' : 
                          getFileIcon(node.key) === 'csv' ? '📊' : 
                          getFileIcon(node.key) === 'md' ? '📄' : 
                          getFileIcon(node.key) === 'zip' ? '📦' :
                          getFileIcon(node.key) === 'png' ? '🖼️' :
                          getFileIcon(node.key) === 'yaml' ? 'YAML' :
                          getFileIcon(node.key) === 'sql' ? 'SQL' :
                          getFileIcon(node.key) === 'py' ? '🐍' :
                          getFileIcon(node.key) === 'tar' ? '📦' :
                          getFileIcon(node.key) === 'tar.gz' ? '📦' :
                          getFileIcon(node.key) === 'pdf' ? 'PDF' :
                          getFileIcon(node.key) === 'word' ? 'W' :
                          getFileIcon(node.key) === 'excel' ? 'X' :
                          getFileIcon(node.key) === 'ppt' ? 'P' :
                          getFileIcon(node.key) === 'doc' ? '📄' :
                          '📄'}
                    </div>
                    <div class="tree-name">${escapeHtml(displayName)}</div>
                </div>
                <div class="tree-size">${formatFileSize(node.size)}</div>
                <div class="tree-modified">${formatDate(node.last_modified)}</div>
            </div>
            ${hasChildren && isExpanded ? `
                <div class="tree-children">
                    ${node.children.map(child => renderTreeNode(child, level + 1, node.key)).join('')}
                </div>
            ` : ''}
        </div>
    `;
    
    return html;
}

// 切换文件夹展开/收拢
async function toggleFolder(key) {
    const isCurrentlyExpanded = state.expandedFolders[key] === true; // 默认收起
    
    // 如果要收起，直接切换状态
    if (isCurrentlyExpanded) {
        state.expandedFolders[key] = false;
        renderApp();
        return;
    }
    
    // 要展开：先标记为展开
    state.expandedFolders[key] = true;
    renderApp();
    
    // 检查该文件夹下是否已有加载的内容
    const hasChildren = state.files.some(file => {
        // 检查是否有文件以该文件夹路径开头（且不是文件夹本身）
        return file.key.startsWith(key) && file.key !== key;
    });
    
    // 如果没有子内容，需要加载该文件夹的内容
    if (!hasChildren) {
        await loadObjectsForFolder(key);
    }
}

// 切换视图模式
function toggleViewMode(mode) {
    state.viewMode = mode;
    renderApp();
}

function renderNewFolderModal() {
    const targetPath = state.newFolderTargetPath || state.currentPath;
    const locationText = targetPath ? `在 "${getFileName(targetPath.slice(0, -1)) || targetPath}" 中创建` : '在当前位置创建';
    
    return `
        <div class="modal-overlay" onclick="hideNewFolderModal()">
            <div class="modal" onclick="event.stopPropagation()">
                <div class="modal-header">
                    <h2>新建文件夹</h2>
                    <button class="modal-close" onclick="hideNewFolderModal()">✕</button>
                </div>
                <div class="modal-description">
                    ${locationText}
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>文件夹名称 <span class="required">*</span></label>
                        <input type="text" id="new-folder-name" placeholder="输入文件夹名称" 
                               onkeydown="if(event.key==='Enter')handleCreateFolder()">
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn-secondary" onclick="hideNewFolderModal()">取消</button>
                    <button type="button" class="btn-primary" onclick="handleCreateFolder()">创建</button>
                </div>
            </div>
        </div>
    `;
}

function renderDeleteConfirmModal() {
    const key = state.deleteTarget;
    const isFolder = key && key.endsWith('/');
    const itemName = getFileName(key);
    const itemType = isFolder ? '文件夹' : '文件';
    
    return `
        <div class="modal-overlay" onclick="hideDeleteConfirmModal()">
            <div class="modal" onclick="event.stopPropagation()">
                <div class="modal-header">
                    <h2>确认删除</h2>
                    <button class="modal-close" onclick="hideDeleteConfirmModal()">✕</button>
                </div>
                <div class="modal-description" style="color: var(--danger-color);">
                    ⚠️ 此操作不可撤销
                </div>
                <div class="modal-body">
                    <p style="font-size: 14px; line-height: 1.6;">
                        确定要删除${itemType} <strong>"${escapeHtml(itemName)}"</strong> 吗？
                    </p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn-secondary" onclick="hideDeleteConfirmModal()">取消</button>
                    <button type="button" class="btn-primary" style="background-color: var(--danger-color);" onclick="confirmDelete()">删除</button>
                </div>
            </div>
        </div>
    `;
}

function renderRenameModal() {
    const key = state.renameTarget;
    const currentName = getFileName(key);
    const isFolder = key && key.endsWith('/');
    const itemType = isFolder ? '文件夹' : '文件';
    
    return `
        <div class="modal-overlay" onclick="hideRenameModal()">
            <div class="modal" onclick="event.stopPropagation()">
                <div class="modal-header">
                    <h2>重命名${itemType}</h2>
                    <button class="modal-close" onclick="hideRenameModal()">✕</button>
                </div>
                <div class="modal-description">
                    将 "${escapeHtml(currentName)}" 重命名为：
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>新名称 <span class="required">*</span></label>
                        <input type="text" id="rename-input" value="${escapeHtml(currentName)}" 
                               placeholder="输入新名称"
                               onkeydown="if(event.key==='Enter')handleRenameConfirm()">
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn-secondary" onclick="hideRenameModal()">取消</button>
                    <button type="button" class="btn-primary" onclick="handleRenameConfirm()">确定</button>
                </div>
            </div>
        </div>
    `;
}

function showAddModal(editingSource = null) {
    state.showAddModal = true;
    state.editingSource = editingSource;
    renderApp();
}

function hideAddModal() {
    state.showAddModal = false;
    state.editingSource = null;
    renderApp();
}

function renderAddModal() {
    const isEditing = state.editingSource !== null;
    const source = state.editingSource || {};
    
    return `
        <div class="modal-overlay" onclick="hideAddModal()">
            <div class="modal" onclick="event.stopPropagation()">
                <div class="modal-header">
                    <h2>${isEditing ? '编辑' : '添加'} S3 数据源</h2>
                    <button class="modal-close" onclick="hideAddModal()">✕</button>
                </div>
                <div class="modal-description">
                    ${isEditing ? '修改数据源配置' : '连接到 S3 存储桶。所有带 * 的字段为必填项。'}
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>数据源名称 <span class="required">*</span></label>
                        <input type="text" id="source-name" placeholder="例如: 生产环境" value="${isEditing ? escapeHtml(source.name) : 'tmp'}">
                    </div>
                    <div class="form-group">
                        <label>存储桶名称 <span class="required">*</span></label>
                        <input type="text" id="source-bucket" placeholder="my-s3-bucket" value="${isEditing ? escapeHtml(source.bucket) : 'tmp'}">
                    </div>
                    <div class="form-group">
                        <label>AWS 区域 <span class="required">*</span></label>
                        <select id="source-region">
                            <option value="">选择区域</option>
                            ${AWS_REGIONS.map(region => `<option value="${region}" ${region === (source.region || 'us-east-1') ? 'selected' : ''}>${region}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Access Key ID</label>
                        <div class="input-with-copy">
                            <input type="text" id="source-access-key" placeholder="${isEditing ? '已保存 (留空保持不变)' : '可选'}" value="${isEditing && source.access_key ? escapeHtml(source.access_key) : ''}">
                            <button type="button" class="btn-copy" onclick="copyToClipboard('source-access-key')" title="复制 Access Key">📋</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Secret Access Key</label>
                        <div class="input-with-copy">
                            <input type="text" id="source-secret-key" placeholder="${isEditing ? '已保存 (留空保持不变)' : '可选'}" value="${isEditing && source.secret_key ? escapeHtml(source.secret_key) : ''}">
                            <button type="button" class="btn-copy" onclick="copyToClipboard('source-secret-key')" title="复制 Secret Key">📋</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Endpoint URL <span class="required">*</span></label>
                        <input type="text" id="source-endpoint" placeholder="https://s3.amazonaws.com" value="${isEditing ? escapeHtml(source.endpoint) : ''}">
                    </div>
                    <div class="form-group">
                        <label>文件下载路径2（可选）</label>
                        <input type="text" id="source-path-endpoint" placeholder="https://cdn.example.com" value="${isEditing && source.path_endpoint ? escapeHtml(source.path_endpoint) : ''}">
                        <div class="field-hint">第二个下载路径，用于"文件下载命令2"</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn-secondary" onclick="hideAddModal()">取消</button>
                    <button type="button" class="btn-primary" onclick="handleSaveDataSource()">${isEditing ? '保存' : '添加'}数据源</button>
                </div>
            </div>
        </div>
    `;
}

function renderContextMenu() {
    return `
        <div class="context-menu" data-menu-type="object" style="left: ${state.contextMenu.x}px; top: ${state.contextMenu.y}px">
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('refresh')">🔄 刷新</div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('newFolder')">📁 新建文件夹</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('upload')">⬆️ 上传</div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('download')">⬇️ 下载</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('share')">🔗 分享</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('downloadCmd')">📋 文件下载命令</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('downloadCmd2')">📋 文件下载命令2</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('rename')">✏️ 重命名</div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" onclick="event.stopPropagation(); handleContextMenuAction('properties')">ℹ️ 属性</div>
            <div class="context-menu-item danger" onclick="event.stopPropagation(); handleContextMenuAction('delete')">🗑️ 删除</div>
        </div>
    `;
}

function renderToast() {
    if (!state.toast) return '';
    
    const { message, type } = state.toast;
    const icon = type === 'success' ? '✓' : '✗';
    const bgColor = type === 'success' ? '#22c55e' : '#ef4444';
    
    return `
        <div class="toast" style="background-color: ${bgColor}">
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${escapeHtml(message)}</span>
        </div>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function copyToClipboard(elementId) {
    const input = document.getElementById(elementId);
    if (!input || !input.value) {
        showToast('没有可复制的内容', 'error');
        return;
    }
    
    try {
        await navigator.clipboard.writeText(input.value);
        showToast('已复制到剪贴板', 'success');
    } catch (err) {
        // 降级方案：使用 select + execCommand
        input.select();
        document.execCommand('copy');
        showToast('已复制到剪贴板', 'success');
    }
}

function positionContextMenu(menuSelector, preferredX, preferredY) {
    const menu = document.querySelector(menuSelector);
    if (!menu) return;
    
    const padding = 10;
    const rect = menu.getBoundingClientRect();
    let x = preferredX;
    let y = preferredY;
    
    if (x + rect.width > window.innerWidth - padding) {
        x = window.innerWidth - rect.width - padding;
    }
    if (y + rect.height > window.innerHeight - padding) {
        y = window.innerHeight - rect.height - padding;
    }
    
    x = Math.max(padding, x);
    y = Math.max(padding, y);
    
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

// Event Handlers
let clickHandlerRegistered = false;

function attachEventListeners() {
    if (!clickHandlerRegistered) {
        clickHandlerRegistered = true;
        document.addEventListener('click', (e) => {
            const contextMenu = document.querySelector('.context-menu');
            if (contextMenu && !contextMenu.contains(e.target)) {
                state.contextMenu = { visible: false, x: 0, y: 0, target: null };
                // 同时关闭数据源上下文菜单
                if (dataSourceContextMenu.visible) {
                    hideDataSourceContextMenu();
                } else {
                    renderApp();
                }
            }
        }, true);
    }
    

}

let transferRenderScheduled = false;
let transferRenderTimer = null;
const TRANSFER_RENDER_INTERVAL = 200;

function scheduleTransferRender() {
    if (transferRenderScheduled) return;
    transferRenderScheduled = true;
    if (transferRenderTimer) {
        clearTimeout(transferRenderTimer);
    }
    transferRenderTimer = setTimeout(() => {
        transferRenderScheduled = false;
        transferRenderTimer = null;
        if (state.activePage === 'transfers') {
            renderApp();
        }
    }, TRANSFER_RENDER_INTERVAL);
}

async function setupTransferListener() {
    try {
        const listen = window.__TAURI__?.event?.listen;
        if (!listen) return;
        await listen('transfer:progress', (event) => {
            updateTransferFromEvent(event.payload);
            scheduleTransferRender();
        });
    } catch (error) {
        console.error('Failed to setup transfer listener', error);
    }
}

// Action Handlers
async function loadDataSources() {
    try {
        state.dataSources = await invoke('get_data_sources');
        renderApp();
        
        // 预连接常用数据源，避免首次点击时建立连接的延迟
        if (state.dataSources.length > 0) {
            const warmupTargets = orderSourcesForWarmup(state.dataSources).slice(0, WARMUP_MAX_CONNECTIONS);
            console.log('Warming up connections for', warmupTargets.length, 'data sources...');
            // 并行预热连接，不阻塞界面
            Promise.all(
                warmupTargets.map(source => 
                    invoke('warm_up_connection', { config: source })
                        .then(() => console.log('Connection warmed up for', source.name))
                        .catch(e => console.warn('Failed to warm up connection for', source.name, e))
                )
            ).then(() => console.log('All connections warmed up'));
        }
    } catch (error) {
        console.error('Failed to load data sources:', error);
    }
}

async function selectDataSource(id) {
    recordRecentSource(id);
    const selectedSource = state.dataSources.find(s => s.id === id) || null;
    
    // 清除搜索状态，确保切换到桶时显示对象列表而不是搜索结果
    state.isSearching = false;
    state.searchQuery = '';
    state.searchResults = [];
    
    Object.assign(
        state,
        buildStatePatchForDataSourceSelection({
            activePage: state.activePage,
            selectedSource,
        })
    );
    
    // 同时加载对象列表和桶总大小，互不影响，速度更快
    await Promise.all([
        loadObjects(),
        loadBucketTotalSize()
    ]);
}

async function loadBucketTotalSize() {
    if (!state.selectedSource) return;
    
    try {
        const totalSize = await invoke('get_bucket_total_size', {
            config: state.selectedSource
        });
        state.bucketTotalSize = totalSize;
        renderApp();
    } catch (error) {
        console.error('Failed to load bucket total size:', error);
        // Don't show alert, just log error
    }
}

async function loadObjects() {
    if (!state.selectedSource) return;
    
    state.loading = true;
    state.continuationToken = null;
    state.hasMore = false;
    renderApp();
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: state.currentPath,
            continuationToken: null,
            batchSize: 5000,
        });
        // Sort files: folders first, then by name
        state.files = sortFiles(response.objects);
        state.continuationToken = response.next_continuation_token;
        state.hasMore = response.has_more;
    } catch (error) {
        console.error('Failed to load objects:', error);
        alert('Failed to load objects: ' + error);
    }
    
    state.loading = false;
    renderApp();
}

// 加载指定文件夹的内容（用于树状视图展开时）
async function loadObjectsForFolder(folderKey) {
    if (!state.selectedSource) return;
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: folderKey,
            continuationToken: null,
            batchSize: 5000,
        });
        
        // 将新加载的对象合并到现有 files 中（避免重复）
        const existingKeys = new Set(state.files.map(f => f.key));
        const newObjects = response.objects.filter(obj => !existingKeys.has(obj.key));
        
        state.files = [...state.files, ...newObjects];
        renderApp();
    } catch (error) {
        console.error('Failed to load objects for folder:', error);
    }
}

async function loadMoreObjects() {
    if (!state.selectedSource || !state.hasMore || state.loadingMore) return;
    
    state.loadingMore = true;
    renderApp();
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: state.currentPath,
            continuationToken: state.continuationToken,
            batchSize: 5000,
        });
        // Append new objects to existing list and sort (folders first)
        state.files = sortFiles([...state.files, ...response.objects]);
        state.continuationToken = response.next_continuation_token;
        state.hasMore = response.has_more;

    } catch (error) {
        console.error('Failed to load more objects:', error);
        showToast('加载更多失败: ' + error, 'error');
    }
    
    state.loadingMore = false;
    renderApp();
}

// 返回顶部
function scrollToTop() {
    const fileTable = document.querySelector('.file-table');
    if (fileTable) {
        fileTable.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// 对文件列表排序：文件夹在前，文件在后，同类型按名称排序
function sortFiles(files) {
    return files.sort((a, b) => {
        // 文件夹排在前面
        if (a.is_folder !== b.is_folder) {
            return a.is_folder ? -1 : 1;
        }
        // 同类型按名称排序
        return a.key.localeCompare(b.key);
    });
}

async function handleSaveDataSource() {
    const name = document.getElementById('source-name').value.trim();
    const bucket = document.getElementById('source-bucket').value.trim();
    const region = document.getElementById('source-region').value;
    const accessKey = document.getElementById('source-access-key').value.trim();
    const secretKey = document.getElementById('source-secret-key').value.trim();
    const endpoint = document.getElementById('source-endpoint').value.trim();
    const pathEndpoint = document.getElementById('source-path-endpoint')?.value?.trim();
    
    if (!name || !bucket || !region || !endpoint) {
        alert('请填写所有必填字段');
        return;
    }
    
    const isEditing = state.editingSource !== null;
    
    try {
        if (isEditing) {
            // 编辑模式：如果用户留空，保留原值；否则使用新值
            const isAccessKeyUnchanged = accessKey === '';
            const isSecretKeyUnchanged = secretKey === '';

            // 更新现有数据源
            const updatedSource = {
                ...state.editingSource,
                name,
                bucket,
                region,
                access_key: isAccessKeyUnchanged ? state.editingSource.access_key : accessKey,
                secret_key: isSecretKeyUnchanged ? state.editingSource.secret_key : secretKey,
                endpoint,
                path_endpoint: pathEndpoint || null,
            };
            
            await invoke('update_data_source', {
                source: updatedSource
            });
            
            // 更新本地状态
            const index = state.dataSources.findIndex(s => s.id === updatedSource.id);
            if (index !== -1) {
                state.dataSources[index] = updatedSource;
                if (state.selectedSource?.id === updatedSource.id) {
                    state.selectedSource = updatedSource;
                }
            }
            showToast('数据源已更新', 'success');
        } else {
            // 添加新数据源
            const source = await invoke('add_data_source', {
                request: {
                    name,
                    bucket,
                    region,
                    access_key: accessKey,
                    secret_key: secretKey,
                    endpoint,
                    path_endpoint: pathEndpoint || null,
                }
            });
            
            state.dataSources.push(source);
            showToast('数据源添加成功', 'success');
        }
        
        hideAddModal();
        renderApp();
    } catch (error) {
        console.error('Failed to save data source:', error);
        showToast(`保存失败: ${error}`, 'error');
    }
}

// 兼容旧版本
async function handleAddDataSource() {
    handleSaveDataSource();
}

function showNewFolderModal(targetPath = null) {
    state.showNewFolderModal = true;
    state.newFolderTargetPath = targetPath;
    renderApp();
    // 聚焦到输入框
    setTimeout(() => {
        const input = document.getElementById('new-folder-name');
        if (input) input.focus();
    }, 0);
}

function hideNewFolderModal() {
    state.showNewFolderModal = false;
    state.newFolderTargetPath = null;
    renderApp();
}

async function handleCreateFolder() {
    const folderNameInput = document.getElementById('new-folder-name');
    const folderName = folderNameInput?.value?.trim();
    
    if (!folderName) {
        alert('请输入文件夹名称');
        return;
    }
    
    // 使用传入的目标路径，如果没有则使用当前路径
    const basePath = state.newFolderTargetPath || state.currentPath;
    const key = basePath ? `${basePath}${folderName}/` : `${folderName}/`;
    
    try {
        await invoke('create_folder', {
            config: state.selectedSource,
            folderKey: key,
        });
        hideNewFolderModal();
        await loadObjects();
        showToast(`文件夹 "${folderName}" 创建成功`, 'success');
    } catch (error) {
        console.error('Failed to create folder:', error);
        showToast(`创建文件夹失败: ${error}`, 'error');
    }
}

// 兼容旧版本的调用
async function handleNewFolder(targetPath = null) {
    showNewFolderModal(targetPath);
}

// 数据源上下文菜单
let dataSourceContextMenu = { visible: false, x: 0, y: 0, sourceId: null };

function showDataSourceContextMenu(event, sourceId) {
    event.preventDefault();
    event.stopPropagation();
    const preferredX = event.clientX;
    const preferredY = event.clientY;
    dataSourceContextMenu = {
        visible: true,
        x: preferredX,
        y: preferredY,
        sourceId: sourceId,
    };
    renderApp();
    requestAnimationFrame(() => {
        positionContextMenu('.context-menu[data-menu-type="data-source"]', preferredX, preferredY);
    });
}

function hideDataSourceContextMenu() {
    dataSourceContextMenu = { visible: false, x: 0, y: 0, sourceId: null };
    renderApp();
}

function renderDataSourceContextMenu() {
    const source = state.dataSources.find(s => s.id === dataSourceContextMenu.sourceId);
    if (!source) return '';
    
    return `
        <div class="context-menu" data-menu-type="data-source" style="left: ${dataSourceContextMenu.x}px; top: ${dataSourceContextMenu.y}px; z-index: 1002;">
            <div class="context-menu-item" onclick="event.stopPropagation(); editDataSource('${source.id}')">✏️ 编辑</div>
            <div class="context-menu-item" onclick="event.stopPropagation(); deleteDataSource('${source.id}')">🗑️ 删除</div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" style="color: var(--text-tertiary); font-size: 11px; cursor: default;">
                ${escapeHtml(source.endpoint.substring(0, 40))}${source.endpoint.length > 40 ? '...' : ''}
            </div>
        </div>
    `;
}

function editDataSource(sourceId) {
    hideDataSourceContextMenu();
    const source = state.dataSources.find(s => s.id === sourceId);
    if (source) {
        showAddModal(source);
    }
}

async function deleteDataSource(sourceId) {
    hideDataSourceContextMenu();
    if (!confirm('确定要删除这个数据源吗？')) return;
    
    try {
        await invoke('delete_data_source', { id: sourceId });
        state.dataSources = state.dataSources.filter(s => s.id !== sourceId);
        if (state.selectedSource?.id === sourceId) {
            state.selectedSource = null;
            state.files = [];
        }
        showToast('数据源已删除', 'success');
        renderApp();
    } catch (error) {
        console.error('Failed to delete data source:', error);
        showToast(`删除失败: ${error}`, 'error');
    }
}

async function handleRefresh() {
    await loadObjects();
}

async function handleGoHome() {
    if (!state.selectedSource) return;
    
    state.loading = true;
    state.currentPath = '';
    state.continuationToken = null;
    state.hasMore = false;
    state.isSearching = false;
    state.searchQuery = '';
    state.searchResults = [];
    renderApp();
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: '',
            continuationToken: null,
            batchSize: 5000,
        });
        // Sort files: folders first, then by name
        state.files = sortFiles(response.objects);
        state.continuationToken = response.next_continuation_token;
        state.hasMore = response.has_more;
    } catch (error) {
        console.error('Failed to go home:', error);
        alert('返回首页失败: ' + error);
    }
    
    state.loading = false;
    renderApp();
}

async function handleGoUp() {
    if (!state.currentPath) return;
    
    const lastSlashIndex = state.currentPath.lastIndexOf('/', state.currentPath.length - 2);
    const parentPath = lastSlashIndex >= 0 ? state.currentPath.substring(0, lastSlashIndex + 1) : '';
    
    state.loading = true;
    state.currentPath = parentPath;
    state.continuationToken = null;
    state.hasMore = false;
    renderApp();
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: parentPath,
            continuationToken: null,
            batchSize: 5000,
        });
        // Sort files: folders first, then by name
        state.files = sortFiles(response.objects);
        state.continuationToken = response.next_continuation_token;
        state.hasMore = response.has_more;
        state.totalSize = response.total_size;
    } catch (error) {
        console.error('Failed to go up:', error);
        alert('返回上级失败: ' + error);
    }
    
    state.loading = false;
    renderApp();
}

async function navigateToFolder(folderKey) {
    if (!state.selectedSource) return;
    
    // Ensure the folder key ends with / for proper S3 prefix navigation
    const normalizedKey = folderKey.endsWith('/') ? folderKey : folderKey + '/';
    
    state.loading = true;
    state.currentPath = normalizedKey;
    state.continuationToken = null;
    state.hasMore = false;
    renderApp();
    
    try {
        const response = await invoke('list_objects', {
            config: state.selectedSource,
            prefix: normalizedKey,
            continuationToken: null,
            batchSize: 5000,
        });
        // Sort files: folders first, then by name
        state.files = sortFiles(response.objects);
        state.continuationToken = response.next_continuation_token;
        state.hasMore = response.has_more;
    } catch (error) {
        console.error('Failed to navigate to folder:', error);
        alert('进入文件夹失败: ' + error);
    }
    
    state.loading = false;
    renderApp();
}

// 处理文件点击
async function handleFileClick(key) {
    if (!state.selectedSource) return;
    
    const fileType = getFileType(key);
    
    if (fileType === 'image') {
        // 图片文件 - 预览
        await openImagePreview(key);
    } else if (fileType === 'text') {
        // 文本文件 - 预览
        await openTextPreview(key);
    } else {
        // 其他文件 - 触发下载
        await handleDownload(key);
    }
}

// 打开图片预览
async function openImagePreview(key) {
    try {
        // 获取预签名 URL
        const url = await invoke('get_presigned_url', {
            config: state.selectedSource,
            key: key,
            expiresInSecs: 3600,
        });
        
        state.preview = {
            visible: true,
            type: 'image',
            key: key,
            url: url,
            content: null,
        };
        renderApp();
    } catch (error) {
        console.error('Failed to open image preview:', error);
        showToast('预览失败: ' + error, 'error');
    }
}

// 打开文本预览
async function openTextPreview(key) {
    try {
        console.log('Loading text content for:', key);
        
        // 使用后端命令直接获取文本内容
        const text = await invoke('get_object_content', {
            config: state.selectedSource,
            key: key,
        });
        
        state.preview = {
            visible: true,
            type: 'text',
            key: key,
            url: null,
            content: text,
        };
        renderApp();
    } catch (error) {
        console.error('Failed to open text preview:', error);
        showToast('预览失败: ' + error, 'error');
    }
}

// 关闭预览
function closePreview() {
    state.preview = null;
    renderApp();
}

// 渲染预览模态框
function renderPreviewModal() {
    if (!state.preview) return '';
    
    const { type, key, url, content } = state.preview;
    const fileName = getFileName(key);
    
    if (type === 'image') {
        return `
            <div class="preview-overlay preview-image-overlay" onclick="closePreview()">
                <button class="preview-close preview-close-float" onclick="closePreview()">✕</button>
                <img src="${url}" alt="${escapeHtml(fileName)}" class="preview-image" onclick="event.stopPropagation()" />
            </div>
        `;
    } else if (type === 'text') {
        // 检测文件语言用于高亮
        const ext = key.split('.').pop().toLowerCase();
        const langMap = {
            'js': 'javascript',
            'ts': 'typescript',
            'jsx': 'javascript',
            'tsx': 'typescript',
            'py': 'python',
            'java': 'java',
            'go': 'go',
            'rs': 'rust',
            'cpp': 'cpp',
            'c': 'c',
            'h': 'cpp',
            'php': 'php',
            'rb': 'ruby',
            'sh': 'bash',
            'yaml': 'yaml',
            'yml': 'yaml',
            'json': 'json',
            'xml': 'xml',
            'html': 'html',
            'css': 'css',
            'sql': 'sql',
            'md': 'markdown',
        };
        const language = langMap[ext] || 'plaintext';
        
        return `
            <div class="preview-overlay" onclick="closePreview()">
                <div class="preview-container preview-text-container" onclick="event.stopPropagation()">
                    <div class="preview-header">
                        <span class="preview-title">${escapeHtml(fileName)} <span class="preview-lang">(${language})</span></span>
                        <button class="preview-close" onclick="closePreview()">✕</button>
                    </div>
                    <div class="preview-content preview-text-content">
                        <pre class="preview-code"><code class="language-${language}">${escapeHtml(content)}</code></pre>
                    </div>
                </div>
            </div>
        `;
    }
    
    return '';
}

async function handleUpload(targetPath = null) {
    if (!state.selectedSource) {
        showToast('请先选择一个数据源', 'error');
        return;
    }
    try {
        const files = await invoke('select_files');
        if (!files || files.length === 0) {
            return;
        }
        for (const file of files) {
            const basePath = targetPath || state.currentPath;
            const fileName = file.name || getFileNameFromPath(file.path);
            const key = basePath ? `${basePath}${fileName}` : fileName;
            const transferId = createTransferId();
            createTransferRecord({
                id: transferId,
                direction: 'upload',
                key,
                total: file.size || null,
                sourceId: state.selectedSource?.id || null,
                sourceName: state.selectedSource?.name || '',
                bucket: state.selectedSource?.bucket || '',
            });
            await invoke('upload_file_from_path', {
                config: state.selectedSource,
                localPath: file.path,
                key,
                transferId,
            });
        }
        await loadObjects();
    } catch (error) {
        console.error('Failed to upload files:', error);
        showToast(`上传失败: ${error}`, 'error');
    }
}

async function handleSearchSubmit() {
    const input = document.getElementById('search-input');
    const query = input ? input.value.trim() : '';
    
    if (!query) {
        clearSearch();
        return;
    }
    
    if (!state.selectedSource) return;
    
    state.searchQuery = query;
    state.isSearching = true;
    state.viewMode = 'list'; // 搜索时强制使用列表视图
    
    // 显示加载状态
    const fileListContainer = document.querySelector('.file-list-container');
    if (fileListContainer) {
        fileListContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <h3>正在搜索...</h3>
                <p>在桶中查找包含 "${escapeHtml(query)}" 的对象</p>
            </div>
        `;
    }
    
    try {
        const response = await invoke('search_objects', {
            config: state.selectedSource,
            query: query,
        });
        
        state.searchResults = response.objects;
        
        // 重新渲染文件列表
        const fileListContainer = document.querySelector('.file-list-container');
        if (fileListContainer) {
            fileListContainer.innerHTML = renderSearchResults();
        }
        
        showToast(`找到 ${response.objects.length} 个匹配对象`, 'success');
    } catch (error) {
        console.error('Search failed:', error);
        showToast('搜索失败: ' + error, 'error');
        
        const fileListContainer = document.querySelector('.file-list-container');
        if (fileListContainer) {
            fileListContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">❌</div>
                    <h3>搜索失败</h3>
                    <p>${escapeHtml(error.toString())}</p>
                </div>
            `;
        }
    }
}

function clearSearch() {
    state.searchQuery = '';
    state.isSearching = false;
    state.searchResults = [];
    
    // 清除输入框
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    
    // 刷新当前目录
    loadObjects();
}

function renderSearchResults() {
    const files = state.searchResults;
    
    if (files.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <h3>没有找到匹配的对象</h3>
                <p>尝试使用其他关键词搜索</p>
            </div>
        `;
    }
    
    return `
        <div class="file-table search-results">
            <div class="search-header">
                <span class="search-result-count">找到 ${files.length} 个匹配结果</span>
                <button type="button" class="search-clear-link" onclick="clearSearch()">返回浏览</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>大小</th>
                        <th>修改时间</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${files.map(file => `
                        <tr class="file-row" onclick="handleFileClick('${escapeHtml(file.key.replace(/'/g, "\\'"))}')" oncontextmenu="showContextMenu(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')" style="cursor: pointer;">
                            <td>
                                <div class="file-name">
                                    <div class="file-icon ${file.is_folder ? 'folder' : getFileIcon(file.key)}">
                                        ${file.is_folder ? '📁' : getFileIcon(file.key) === 'json' ? '{}' : 
                                          getFileIcon(file.key) === 'csv' ? '📊' : 
                                          getFileIcon(file.key) === 'md' ? '📄' : 
                                          getFileIcon(file.key) === 'pdf' ? '📕' :
                                          getFileIcon(file.key) === 'image' ? '🖼️' :
                                          '📄'}
                                    </div>
                                    <span class="file-name-text" title="${escapeHtml(file.key)}">${highlightSearchTerm(escapeHtml(file.key), state.searchQuery)}</span>
                                </div>
                            </td>
                            <td>${file.size !== undefined && file.size !== null ? formatFileSize(file.size) : '-'}</td>
                            <td>${file.last_modified ? formatDate(file.last_modified) : '-'}</td>
                            <td>
                                <div class="file-actions">
                                    ${!file.is_folder ? `
                                        <button type="button" class="file-action-btn" onclick="event.stopPropagation(); handleDownload('${escapeHtml(file.key.replace(/'/g, "\\'"))}')" title="下载">⬇️</button>
                                    ` : ''}
                                    <button type="button" class="file-action-btn" onclick="event.stopPropagation(); showContextMenu(event, '${escapeHtml(file.key.replace(/'/g, "\\'"))}')" title="更多">⋯</button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function highlightSearchTerm(text, query) {
    if (!query) return text;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);
    if (index === -1) return text;
    
    const before = text.substring(0, index);
    const match = text.substring(index, index + query.length);
    const after = text.substring(index + query.length);
    return `${before}<mark class="search-highlight">${match}</mark>${after}`;
}

function showContextMenu(event, key) {
    event.preventDefault();
    const preferredX = event.clientX;
    const preferredY = event.clientY;
    
    state.contextMenu = {
        visible: true,
        x: preferredX,
        y: preferredY,
        target: key,
    };
    renderApp();
    requestAnimationFrame(() => {
        positionContextMenu('.context-menu[data-menu-type="object"]', preferredX, preferredY);
    });
}

async function handleContextMenuAction(action) {
    if (!state.contextMenu.target) return;
    
    const key = state.contextMenu.target;
    
    switch (action) {
        case 'refresh':
            await handleRefresh();
            break;
        case 'newFolder': {
            // 如果右键点击的是文件夹，则在该文件夹内创建新文件夹
            const isFolder = key.endsWith('/');
            const createPath = isFolder ? key : state.currentPath;
            await handleNewFolder(createPath);
            break;
        }
        case 'upload': {
            // 如果右键点击的是文件夹，则上传到该文件夹内
            const isFolder = key.endsWith('/');
            const uploadPath = isFolder ? key : state.currentPath;
            await handleUpload(uploadPath);
            break;
        }
        case 'download':
            await handleDownload(key);
            break;
        case 'delete':
            showDeleteConfirmModal(key);
            break;
        case 'rename':
            await handleRename(key);
            break;
        case 'properties':
            await handleProperties(key);
            break;
        case 'share':
            await handleShare(key);
            break;
        case 'downloadCmd':
            await handleCopyDownloadCmd(key, false);
            break;
        case 'downloadCmd2':
            await handleCopyDownloadCmd(key, true);
            break;
    }
    
    state.contextMenu = { visible: false, x: 0, y: 0, target: null };
    renderApp();
}

async function handleDownload(key) {
    try {
        const filename = getFileName(key);
        const isFolder = key.endsWith('/');
        
        console.log('开始下载:', key, '文件名:', filename, '是否文件夹:', isFolder);
        
        if (isFolder) {
            // 下载文件夹 - 选择保存目录
            const result = await invoke('select_directory');
            if (!result) {
                console.log('用户取消了保存对话框');
                return;
            }
            
            const destDir = result + '/' + filename;
            console.log('开始下载文件夹到:', destDir);
            
            showToast('开始下载文件夹...', 'success');
            const transferId = createTransferId();
            createTransferRecord({
                id: transferId,
                direction: 'download',
                key,
                total: null,
                sourceId: state.selectedSource?.id || null,
                sourceName: state.selectedSource?.name || '',
                bucket: state.selectedSource?.bucket || '',
            });
            
            const count = await invoke('download_folder', {
                config: state.selectedSource,
                folderKey: key,
                destDir: destDir,
                transferId: transferId,
            });
            
            showToast(`文件夹下载完成，共 ${count} 个文件`, 'success');
        } else {
            // 下载单个文件
            const savePath = await invoke('select_save_location', {
                defaultName: filename,
            });
            
            if (!savePath) {
                console.log('用户取消了保存对话框');
                return;
            }
            
            console.log('开始调用 download_file, path:', savePath);
            const transferId = createTransferId();
            createTransferRecord({
                id: transferId,
                direction: 'download',
                key,
                total: null,
                sourceId: state.selectedSource?.id || null,
                sourceName: state.selectedSource?.name || '',
                bucket: state.selectedSource?.bucket || '',
            });
            await invoke('download_file', {
                config: state.selectedSource,
                key: key,
                destPath: savePath,
                transferId: transferId,
            });
            
            showToast(`"${filename}" 下载完成`, 'success');
        }
    } catch (error) {
        console.error('下载失败:', error);
        showToast(`下载失败: ${error}`, 'error');
    }
}

async function handleShare(key) {
    console.log('handleShare called with key:', key);
    console.log('selectedSource:', state.selectedSource);
    
    try {
        const url = await invoke('get_presigned_url', {
            config: state.selectedSource,
            key: key,
            expiresInSecs: 3600,
        });
        console.log('Got presigned URL:', url);
        
        if (window.__TAURI__ && window.__TAURI__.clipboardManager) {
            console.log('Using Tauri clipboardManager API');
            await window.__TAURI__.clipboardManager.writeText(url);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            console.log('Using navigator.clipboard.writeText');
            await navigator.clipboard.writeText(url);
        } else {
            console.log('Using fallbackCopy');
            fallbackCopy(url);
        }
        
        showToast('链接已复制到剪贴板', 'success');
    } catch (error) {
        console.error('Failed to share:', error);
        showToast(`分享失败: ${error}`, 'error');
    }
}

async function handleCopyDownloadCmd(key, usePathEndpoint2 = false) {
    console.log('handleCopyDownloadCmd called with key:', key, 'usePathEndpoint2:', usePathEndpoint2);
    console.log('selectedSource:', state.selectedSource);
    
    if (!state.selectedSource) {
        console.error('No selectedSource!');
        showToast('请先选择一个数据源', 'error');
        return;
    }
    
    // 根据参数选择使用哪个 endpoint
    const endpoint = usePathEndpoint2 
        ? (state.selectedSource.path_endpoint || state.selectedSource.endpoint)
        : state.selectedSource.endpoint;
    
    if (usePathEndpoint2 && !state.selectedSource.path_endpoint) {
        showToast('未配置"文件下载路径2"，请检查数据源设置', 'error');
        return;
    }
    
    const fullUrl = `${endpoint}/${state.selectedSource.bucket}/${key}`;
    const curlCmd = `curl -O ${fullUrl}`;
    console.log('Curl command to copy:', curlCmd);
    
    try {
        if (window.__TAURI__ && window.__TAURI__.clipboardManager) {
            console.log('Using Tauri clipboardManager API');
            await window.__TAURI__.clipboardManager.writeText(curlCmd);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            console.log('Using navigator.clipboard.writeText');
            await navigator.clipboard.writeText(curlCmd);
        } else {
            console.log('Using fallbackCopy');
            fallbackCopy(curlCmd);
        }
        
        const label = usePathEndpoint2 ? '文件下载命令2' : '文件下载命令';
        showToast(`${label}已复制到剪贴板`, 'success');
    } catch (error) {
        console.error('Failed to copy download cmd:', error);
        showToast(`复制失败: ${error}`, 'error');
    }
}

function handleContextAction(action) {
    handleContextMenuAction(action);
}

async function handleProperties(key) {
    if (!state.selectedSource) {
        showToast('请先选择一个数据源', 'error');
        return;
    }
    
    try {
        const info = await invoke('get_object_info', {
            config: state.selectedSource,
            key: key,
        });
        alert('Object Info:\n' + JSON.stringify(info, null, 2));
    } catch (error) {
        if (key.endsWith('/')) {
            const info = {
                key,
                bucket: state.selectedSource.bucket,
                type: 'folder',
            };
            alert('Object Info:\n' + JSON.stringify(info, null, 2));
            return;
        }
        console.error('Failed to get properties:', error);
        alert('Failed to get properties: ' + error);
    }
}

function showDeleteConfirmModal(key) {
    state.showDeleteConfirm = true;
    state.deleteTarget = key;
    renderApp();
}

function hideDeleteConfirmModal() {
    state.showDeleteConfirm = false;
    state.deleteTarget = null;
    renderApp();
}

// 显示 Toast 提示
function showToast(message, type = 'success') {
    state.toast = { message, type, visible: true };
    renderApp();
    
    // 3秒后自动隐藏
    setTimeout(() => {
        state.toast = null;
        renderApp();
    }, 3000);
}

async function confirmDelete() {
    if (!state.deleteTarget) return;
    
    const key = state.deleteTarget;
    const itemName = getFileName(key);
    hideDeleteConfirmModal();
    
    try {
        await invoke('delete_object', {
            config: state.selectedSource,
            key: key,
        });
        await loadObjects();
        // 使用 Toast 替代 alert
        showToast(`"${itemName}" 已删除`, 'success');
    } catch (error) {
        console.error('Failed to delete:', error);
        showToast(`删除失败: ${error}`, 'error');
    }
}

// 保留旧函数用于兼容
async function handleDelete(key) {
    showDeleteConfirmModal(key);
}

function showRenameModal(key) {
    state.showRenameModal = true;
    state.renameTarget = key;
    renderApp();
    // 聚焦到输入框并选中现有文本
    setTimeout(() => {
        const input = document.getElementById('rename-input');
        if (input) {
            input.focus();
            input.select();
        }
    }, 0);
}

function hideRenameModal() {
    state.showRenameModal = false;
    state.renameTarget = null;
    renderApp();
}

async function handleRenameConfirm() {
    if (!state.renameTarget) return;
    
    const key = state.renameTarget;
    const isFolder = key.endsWith('/');
    const currentName = getFileName(key);
    
    const newNameInput = document.getElementById('rename-input');
    const newName = newNameInput?.value?.trim();
    
    if (!newName || newName === currentName) {
        hideRenameModal();
        return;
    }
    
    // 计算父路径
    const lastSlashIndex = key.lastIndexOf('/');
    const parentPath = lastSlashIndex >= 0 ? key.substring(0, lastSlashIndex + 1) : '';
    
    // 如果是文件夹，新名称也要加上 / 后缀
    const newKey = isFolder ? `${parentPath}${newName}/` : `${parentPath}${newName}`;
    
    hideRenameModal();
    
    try {
        await invoke('rename_object', {
            config: state.selectedSource,
            oldKey: key,
            newKey: newKey,
        });
        await loadObjects();
        showToast(`已重命名为 "${newName}"`, 'success');
    } catch (error) {
        console.error('Failed to rename:', error);
        showToast(`重命名失败: ${error}`, 'error');
    }
}

// 兼容旧版本调用
async function handleRename(key) {
    showRenameModal(key);
}

function handleFileAction(key, action) {
    switch (action) {
        case 'more':
            showContextMenu({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, preventDefault: () => {} }, key);
            break;
        default:
            console.log('Unknown action:', action);
    }
}

function fallbackCopy(text) {
    console.log('fallbackCopy called with:', text);
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        const result = document.execCommand('copy');
        console.log('execCommand copy result:', result);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
    document.body.removeChild(textArea);
}

console.log('=== Clipboard API Check ===');
console.log('window.__TAURI__:', window.__TAURI__);
console.log('window.__TAURI__.clipboardManager:', window.__TAURI__?.clipboardManager);
console.log('navigator.clipboard:', navigator.clipboard);

// Make functions global for onclick handlers
window.showAddModal = showAddModal;
window.hideAddModal = hideAddModal;
window.showNewFolderModal = showNewFolderModal;
window.hideNewFolderModal = hideNewFolderModal;
window.handleCreateFolder = handleCreateFolder;
window.showDeleteConfirmModal = showDeleteConfirmModal;
window.hideDeleteConfirmModal = hideDeleteConfirmModal;
window.confirmDelete = confirmDelete;
window.showRenameModal = showRenameModal;
window.hideRenameModal = hideRenameModal;
window.handleRenameConfirm = handleRenameConfirm;
window.showDataSourceContextMenu = showDataSourceContextMenu;
window.hideDataSourceContextMenu = hideDataSourceContextMenu;
window.editDataSource = editDataSource;
window.deleteDataSource = deleteDataSource;
window.selectDataSource = selectDataSource;
window.handleAddDataSource = handleAddDataSource;
window.handleSaveDataSource = handleSaveDataSource;
window.handleNewFolder = handleNewFolder;
window.handleRefresh = handleRefresh;
window.handleGoHome = handleGoHome;
window.handleGoUp = handleGoUp;
window.navigateToFolder = navigateToFolder;
window.handleUpload = handleUpload;
window.handleSearchSubmit = handleSearchSubmit;
window.clearSearch = clearSearch;
window.showContextMenu = showContextMenu;
window.handleContextMenuAction = handleContextMenuAction;
window.handleCopyDownloadCmd = handleCopyDownloadCmd;
window.handleDelete = handleDelete;
window.handleRename = handleRename;
window.handleFileAction = handleFileAction;
window.toggleViewMode = toggleViewMode;
window.toggleFolder = toggleFolder;
window.loadMoreObjects = loadMoreObjects;
window.loadBucketTotalSize = loadBucketTotalSize;
window.scrollToTop = scrollToTop;
window.handleFileClick = handleFileClick;
window.closePreview = closePreview;

// Drag and Drop Functions

// 处理外部文件拖入
function handleDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('handleDragEnter triggered');
    console.log('dragState.sourceKey:', dragState.sourceKey);
    console.log('dataTransfer.types:', Array.from(e.dataTransfer.types));
    console.log('dataTransfer.files.length:', e.dataTransfer.files.length);
    
    // 如果正在进行内部拖拽，忽略外部拖拽事件
    if (dragState.sourceKey) {
        console.log('Skipping - internal drag in progress');
        return;
    }
    
    // 处理任何类型的拖拽（macOS 可能不显示 'Files' 类型）
    // 只要 files 有内容或者是外部拖拽，就显示高亮
    if (e.dataTransfer.files.length > 0 || e.dataTransfer.types.length > 0) {
        console.log('Setting dragOver to true');
        state.dragOver = true;
        renderApp();
    }
}

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    // 检查是否真的离开了元素
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        state.dragOver = false;
        renderApp();
    }
}

async function handleNativeFileDrop(paths) {
    if (!state.selectedSource) {
        showToast('请先选择一个数据源', 'error');
        return;
    }
    
    const files = (paths || []).filter(Boolean);
    if (files.length === 0) {
        showToast('无法读取拖入的文件，请重试', 'error');
        return;
    }
    
    const fileNames = files.map(p => getFileNameFromPath(p)).join(', ');
    const targetPath = state.currentPath || '根目录';
    
    const confirmed = confirm(`确定要上传以下文件到 "${targetPath}" 吗？\n\n${fileNames}`);
    if (!confirmed) return;
    
    let successCount = 0;
    for (const path of files) {
        const success = await uploadDroppedPath(path, state.currentPath);
        if (success) successCount++;
    }
    
    await loadObjects();
    showToast(`成功上传 ${successCount}/${files.length} 个文件`, 'success');
}

// 处理外部文件拖入放下
async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('handleDrop triggered');
    console.log('dragState.sourceKey:', dragState.sourceKey);
    console.log('dataTransfer.types:', e.dataTransfer.types);
    console.log('dataTransfer.files:', e.dataTransfer.files);
    
    // 如果有内部对象拖拽，不处理
    if (dragState.sourceKey) {
        console.log('Skipping - internal drag in progress');
        state.dragOver = false;
        renderApp();
        return;
    }
    
    state.dragOver = false;
    
    if (!state.selectedSource) {
        showToast('请先选择一个数据源', 'error');
        return;
    }
    
    // 处理外部文件拖拽
    let files = Array.from(e.dataTransfer.files);
    console.log('Files from dataTransfer:', files.length);
    
    // 在 macOS 上，有时 files 会是空的，尝试使用 items
    if (files.length === 0 && e.dataTransfer.items) {
        console.log('Trying to get files from items...');
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const item = e.dataTransfer.items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        console.log('Files from items:', files.length);
    }
    
    if (files.length === 0) {
        console.log('No files found');
        showToast('无法读取拖入的文件，请重试', 'error');
        renderApp();
        return;
    }
    
    const fileNames = files.map(f => f.name).join(', ');
    const targetPath = state.currentPath || '根目录';
    
    // 确认弹窗（必须在 renderApp 之前）
    const confirmed = confirm(`确定要上传以下文件到 "${targetPath}" 吗？\n\n${fileNames}`);
    if (!confirmed) {
        renderApp();
        return;
    }
    
    renderApp();
    
    // 上传所有文件
    let successCount = 0;
    for (const file of files) {
        const success = await uploadDroppedFile(file, state.currentPath);
        if (success) successCount++;
    }
    
    await loadObjects();
    showToast(`成功上传 ${successCount}/${files.length} 个文件`, 'success');
}

async function uploadDroppedFile(file, targetPath) {
    const key = targetPath ? `${targetPath}${file.name}` : file.name;
    const transferId = createTransferId();
    createTransferRecord({
        id: transferId,
        direction: 'upload',
        key,
        total: file.size,
        sourceId: state.selectedSource?.id || null,
        sourceName: state.selectedSource?.name || '',
        bucket: state.selectedSource?.bucket || '',
    });
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        
        await invoke('upload_file', {
            config: state.selectedSource,
            localPath: Array.from(bytes),
            key: key,
            transferId: transferId,
        });
        console.log('Uploaded:', file.name);
        return true;
    } catch (error) {
        console.error('Failed to upload file:', file.name, error);
        showToast(`上传失败 ${file.name}: ${error}`, 'error');
        return false;
    }
}

async function uploadDroppedPath(path, targetPath) {
    const fileName = getFileNameFromPath(path);
    if (!fileName) return false;
    const key = targetPath ? `${targetPath}${fileName}` : fileName;
    const transferId = createTransferId();
    createTransferRecord({
        id: transferId,
        direction: 'upload',
        key,
        total: null,
        sourceId: state.selectedSource?.id || null,
        sourceName: state.selectedSource?.name || '',
        bucket: state.selectedSource?.bucket || '',
    });
    
    try {
        await invoke('upload_file_from_path', {
            config: state.selectedSource,
            localPath: path,
            key: key,
            transferId: transferId,
        });
        console.log('Uploaded:', fileName);
        return true;
    } catch (error) {
        console.error('Failed to upload file:', fileName, error);
        showToast(`上传失败 ${fileName}: ${error}`, 'error');
        return false;
    }
}

// 处理对象拖拽移动
function handleItemDragStart(e, key) {
    dragState.sourceKey = key;
    dragState.targetKey = null;
    e.dataTransfer.effectAllowed = 'move';
    // 必须设置数据，否则 Firefox 不会触发 drag
    e.dataTransfer.setData('text/plain', key);
    
    // 清除外部文件拖拽的高亮
    if (state.dragOver) {
        state.dragOver = false;
        renderApp();
    }
    
    console.log('开始内部拖拽:', key);
}

function handleItemDragEnd() {
    dragState.sourceKey = null;
    dragState.targetKey = null;
    document.querySelectorAll('.drag-target').forEach(el => el.classList.remove('drag-target'));
}

function handleItemDragOver(e) {
    // 必须 preventDefault 才能允许 drop
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleItemDragEnter(e, folderKey) {
    e.preventDefault();
    e.stopPropagation();
    
    // 检查是否可以拖入此文件夹
    const sourceKey = dragState.sourceKey;
    console.log('Drag enter folder:', folderKey, 'source:', sourceKey);
    
    if (!sourceKey || sourceKey === folderKey) return;
    if (sourceKey.endsWith('/') && folderKey.startsWith(sourceKey)) return;
    
    dragState.targetKey = folderKey;
    
    // 直接操作 DOM 添加高亮，避免重新渲染
    const row = e.currentTarget;
    row.classList.add('drag-target');
    console.log('进入文件夹:', folderKey);
}

function handleItemDragLeave(e, folderKey) {
    e.stopPropagation();
    
    // 检查是否真的离开了当前元素
    const relatedTarget = e.relatedTarget;
    const currentTarget = e.currentTarget;
    
    // 如果 relatedTarget 是当前元素或其子元素，不算离开
    if (relatedTarget && (currentTarget === relatedTarget || currentTarget.contains(relatedTarget))) {
        return;
    }
    
    // 直接操作 DOM 移除高亮
    const row = e.currentTarget;
    row.classList.remove('drag-target');
    
    if (dragState.targetKey === folderKey) {
        dragState.targetKey = null;
    }
    console.log('离开文件夹:', folderKey);
}

async function handleItemDrop(e, folderKey) {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('=== handleItemDrop called ===');
    console.log('Target folder:', folderKey);
    console.log('dragState:', JSON.stringify(dragState));
    
    const sourceKey = dragState.sourceKey;
    console.log('Source key from dragState:', sourceKey);
    
    // 移除高亮
    const row = e.currentTarget;
    if (row) {
        row.classList.remove('drag-target');
    }
    
    // 重置拖拽状态
    dragState.sourceKey = null;
    dragState.targetKey = null;
    
    // 获取有效的 source key
    let effectiveSourceKey = sourceKey;
    if (!effectiveSourceKey) {
        console.log('No source key - trying to get from dataTransfer');
        effectiveSourceKey = e.dataTransfer.getData('text/plain');
    }
    
    if (!effectiveSourceKey || effectiveSourceKey === folderKey) {
        console.log('无效的拖拽操作');
        return;
    }
    
    // 防止拖入自己的子文件夹
    if (effectiveSourceKey.endsWith('/') && folderKey.startsWith(effectiveSourceKey)) {
        showToast('不能将文件夹拖入其子文件夹', 'error');
        return;
    }
    
    const fileName = getFileName(effectiveSourceKey);
    const destKey = `${folderKey}${fileName}`;
    const folderName = getFileName(folderKey);
    
    // 确认弹窗
    const confirmed = confirm(`确定要将 "${fileName}" 移动到 "${folderName}" 吗？`);
    if (!confirmed) return;
    
    console.log('执行移动:', effectiveSourceKey, '->', destKey);
    
    try {
        await invoke('rename_object', {
            config: state.selectedSource,
            oldKey: effectiveSourceKey,
            newKey: destKey,
        });
        await loadObjects();
        showToast(`已移动到 ${folderName}`, 'success');
    } catch (error) {
        console.error('移动失败:', error);
        showToast(`移动失败: ${error}`, 'error');
    }
}

// Expose drag functions to window
window.handleDragEnter = handleDragEnter;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDrop = handleDrop;
window.handleItemDragStart = handleItemDragStart;
window.handleItemDragEnd = handleItemDragEnd;
window.handleItemDragOver = handleItemDragOver;
window.handleItemDragEnter = handleItemDragEnter;
window.handleItemDragLeave = handleItemDragLeave;
window.handleItemDrop = handleItemDrop;
window.setActivePage = setActivePage;
window.clearTransferHistory = clearTransferHistory;
window.deleteTransferRecord = deleteTransferRecord;
window.toggleTransferPause = toggleTransferPause;

// Initialize
async function main() {
    loadTransferHistory();
    setupTransferListener();
    await loadDataSources();
    try {
        const appWindow = getCurrentWindow?.();
        if (appWindow?.onDragDropEvent) {
            dragDropUnlisten = await appWindow.onDragDropEvent(async (event) => {
                if (dragState.sourceKey) return;
                const type = event.payload.type;
                if (type === 'enter' || type === 'over') {
                    if (!state.dragOver) {
                        state.dragOver = true;
                        renderApp();
                    }
                    return;
                }
                if (type === 'leave') {
                    if (state.dragOver) {
                        state.dragOver = false;
                        renderApp();
                    }
                    return;
                }
                if (type === 'drop') {
                    state.dragOver = false;
                    renderApp();
                    await handleNativeFileDrop(event.payload.paths || []);
                }
            });
        }
    } catch (error) {
        console.error('Failed to setup native drag drop', error);
    }
}

main();
