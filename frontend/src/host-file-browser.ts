import { NetworkManager } from './NetworkManager.js';
import { CustomDialog } from './custom-dialog.js';

export interface FileFilterPreset {
    label: string;
    extensions: string[]; // e.g. ['.k', '.key'] or ['*']
}

export interface HostFileBrowserOptions {
    title?: string;
    mode?: 'open' | 'save';
    defaultFilename?: string;
    initialPath?: string;
    filters?: FileFilterPreset[];
    defaultFilterIndex?: number;
    selectFolderOnly?: boolean;
    onSelect?: (path: string) => void;
}

export interface FileEntry {
    name: string;
    isDir: boolean;
    isSymlink?: boolean;
    size: number;
    mtime?: number;
    ext?: string;
    type?: string;
}

type SortKey = 'name' | 'type' | 'size' | 'mtime';
type SortDirection = 'asc' | 'desc';
type ItemTypeFilter = 'all' | 'files' | 'folders';

export class HostFileBrowserModal {
    private networkManager: NetworkManager | null = null;
    private mode: 'open' | 'save' = 'open';
    private selectFolderOnly: boolean = false;
    private titleText: string = '';
    private onSelectCallback: (path: string) => void = () => {};
    private defaultFilename: string = '';
    
    private currentPath: string = '';
    private parentPath: string = '';
    private projectPath: string = '/home/chris/antigrav/blastdemon';
    private homePath: string = '/home/chris';
    private selectedFilename: string = '';
    
    // Navigation History
    private historyStack: string[] = [];
    private historyIndex: number = -1;
    
    // Raw & Filtered entries
    private rawEntries: FileEntry[] = [];
    private displayedEntries: FileEntry[] = [];
    
    // Sorting & Filtering state
    private sortKey: SortKey = 'name';
    private sortDir: SortDirection = 'asc';
    private foldersFirst: boolean = true;
    private searchFilter: string = '';
    private activeExtensionFilter: string[] = ['*'];
    private itemTypeFilter: ItemTypeFilter = 'all';
    private showHidden: boolean = false;
    private filterPresets: FileFilterPreset[] = [
        { label: 'All Files (*.*)', extensions: ['*'] },
        { label: 'Model Files (*.json)', extensions: ['.json'] },
        { label: 'LS-DYNA Keyword Files (*.k, *.key, *.dyn)', extensions: ['.k', '.key', '.dyn'] },
        { label: 'STL 3D Geometry (*.stl)', extensions: ['.stl'] },
        { label: 'Simulation Data (*.h5, *.hdf5, *.xdmf)', extensions: ['.h5', '.hdf5', '.xdmf', '.xmf'] },
        { label: 'Source / Scripts (*.cpp, *.cu, *.h, *.py, *.ts)', extensions: ['.cpp', '.cu', '.h', '.hpp', '.py', '.ts', '.js'] },
        { label: 'Text / Data Files (*.txt, *.csv, *.dat)', extensions: ['.txt', '.csv', '.dat', '.log'] }
    ];
    private selectedFilterPresetIndex: number = 0;

    // DOM Elements
    private modalEl: HTMLDivElement | null = null;
    private breadcrumbsContainer: HTMLDivElement | null = null;
    private addressInput: HTMLInputElement | null = null;
    private addressEditMode: boolean = false;
    private addressBarContainer: HTMLDivElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private filterSelectEl: HTMLSelectElement | null = null;
    private listContainer: HTMLDivElement | null = null;
    private tableBodyEl: HTMLTableSectionElement | null = null;
    private fileInput: HTMLInputElement | null = null;
    private statusTextEl: HTMLSpanElement | null = null;
    private loadingEl: HTMLDivElement | null = null;
    private backBtn: HTMLButtonElement | null = null;
    private fwdBtn: HTMLButtonElement | null = null;
    private upBtn: HTMLButtonElement | null = null;
    
    private messageCallback: ((data: string | ArrayBuffer) => void) | null = null;
    private selectedRowIndex: number = -1;

    constructor(
        networkManager?: NetworkManager | null,
        modeOrOptions: 'open' | 'save' | HostFileBrowserOptions = 'open',
        defaultFilenameOrLegacy: string = '',
        legacyOnSelect?: (path: string) => void
    ) {
        // Resolve network manager
        this.networkManager = networkManager || (window as any).networkManager || null;
        
        if (typeof modeOrOptions === 'object') {
            const opts = modeOrOptions;
            this.mode = opts.mode || 'open';
            this.selectFolderOnly = !!opts.selectFolderOnly;
            this.defaultFilename = opts.defaultFilename || '';
            this.titleText = opts.title || (this.selectFolderOnly ? 'Select Folder (Host)' : (this.mode === 'open' ? 'Open File (Host)' : 'Save File As (Host)'));
            if (opts.filters && opts.filters.length > 0) {
                this.filterPresets = opts.filters;
            }
            if (opts.defaultFilterIndex !== undefined && opts.defaultFilterIndex < this.filterPresets.length) {
                this.selectedFilterPresetIndex = opts.defaultFilterIndex;
                this.activeExtensionFilter = this.filterPresets[this.selectedFilterPresetIndex].extensions;
            }
            if (opts.onSelect) {
                this.onSelectCallback = opts.onSelect;
            }
        } else {
            // Legacy signature: (networkManager, mode, defaultFilename, onSelect)
            this.mode = modeOrOptions;
            this.defaultFilename = defaultFilenameOrLegacy;
            if (defaultFilenameOrLegacy === 'select_dir') {
                this.selectFolderOnly = true;
                this.defaultFilename = '';
            } else if (defaultFilenameOrLegacy === 'select_file') {
                this.defaultFilename = '';
            }
            this.titleText = this.selectFolderOnly ? 'Select Directory (Host)' : (this.mode === 'open' ? 'Open Model File (Host)' : 'Save Model As (Host)');
            if (legacyOnSelect) {
                this.onSelectCallback = legacyOnSelect;
            }
        }
    }

    public open(startPath: string = ""): void {
        this.injectStyles();
        this.createModalDOM();
        
        // Clean default filename if it was a placeholder
        if (this.defaultFilename === 'select_file' || this.defaultFilename === 'select_dir') {
            this.defaultFilename = '';
        }

        // Setup network message handler
        this.messageCallback = (data: string | ArrayBuffer) => {
            if (typeof data === 'string') {
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'list_dir_response') {
                        this.hideLoading();
                        if (msg.status === 'success') {
                            this.currentPath = msg.currentPath || '';
                            this.parentPath = msg.parentPath || '';
                            if (msg.projectPath) this.projectPath = msg.projectPath;
                            if (msg.homePath) this.homePath = msg.homePath;
                            
                            this.updateNavHistory(this.currentPath);
                            this.rawEntries = msg.entries || [];
                            this.renderBreadcrumbs();
                            this.applyFilterAndRender();
                        } else {
                            this.showErrorBanner(`Failed to read directory: ${msg.error || 'Unknown error'}`);
                        }
                    } else if (msg.type === 'create_dir_response') {
                        if (msg.status === 'success') {
                            if (msg.path) {
                                this.navigate(msg.path);
                            } else {
                                this.refresh();
                            }
                        } else {
                            CustomDialog.alert("Failed to create directory: " + (msg.error || 'Unknown error'));
                        }
                    }
                } catch(e) {
                    console.error('[HostFileBrowser] Error processing message:', e);
                }
            }
        };

        if (this.networkManager) {
            this.networkManager.onMessage(this.messageCallback);
        }

        // Determine target path
        let target = startPath ? startPath.trim() : '';
        if (target === 'select_file' || target === 'select_dir') {
            target = '';
        }

        // If target looks like a full file path, extract parent folder and prefill filename
        if (target && (target.includes('/') || target.includes('\\'))) {
            const lastSlash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
            if (lastSlash !== -1) {
                const potentialFilename = target.substring(lastSlash + 1);
                if (potentialFilename && potentialFilename.includes('.')) {
                    this.selectedFilename = potentialFilename;
                    if (this.fileInput) this.fileInput.value = potentialFilename;
                    target = target.substring(0, lastSlash);
                }
            }
        }

        this.navigate(target || this.projectPath);
    }

    public close(): void {
        if (this.networkManager && this.messageCallback) {
            this.networkManager.offMessage(this.messageCallback);
            this.messageCallback = null;
        }
        if (this.modalEl) {
            this.modalEl.remove();
            this.modalEl = null;
        }
    }

    private navigate(path: string): void {
        this.showLoading();
        this.hideErrorBanner();
        
        if (!this.networkManager || !this.networkManager.isConnected()) {
            // Attempt to resolve active networkManager from window if not ready
            this.networkManager = (window as any).networkManager || this.networkManager;
            if (!this.networkManager || !this.networkManager.isConnected()) {
                this.showErrorBanner("Connecting to host server... Please ensure Broker is running.");
                // Retry when networkManager connects
                if (this.networkManager) {
                    const onOpenOnce = () => {
                        this.navigate(path);
                    };
                    this.networkManager.onOpen(onOpenOnce);
                }
                return;
            }
        }

        this.networkManager.send({
            command: "LIST_DIR",
            path: path
        });
    }

    private refresh(): void {
        this.navigate(this.currentPath);
    }

    private updateNavHistory(path: string): void {
        if (this.historyIndex === -1 || this.historyStack[this.historyIndex] !== path) {
            // Truncate any forward history and push new path
            this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
            this.historyStack.push(path);
            this.historyIndex = this.historyStack.length - 1;
        }
        this.updateNavButtons();
    }

    private navBack(): void {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.navigate(this.historyStack[this.historyIndex]);
        }
    }

    private navForward(): void {
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyIndex++;
            this.navigate(this.historyStack[this.historyIndex]);
        }
    }

    private navUp(): void {
        if (this.parentPath && this.parentPath !== this.currentPath) {
            this.navigate(this.parentPath);
        } else if (this.currentPath.length > 1) {
            const lastSlash = this.currentPath.lastIndexOf('/');
            const parent = lastSlash > 0 ? this.currentPath.substring(0, lastSlash) : '/';
            this.navigate(parent);
        }
    }

    private updateNavButtons(): void {
        if (this.backBtn) {
            this.backBtn.disabled = this.historyIndex <= 0;
            this.backBtn.style.opacity = this.historyIndex <= 0 ? '0.4' : '1';
        }
        if (this.fwdBtn) {
            this.fwdBtn.disabled = this.historyIndex >= this.historyStack.length - 1;
            this.fwdBtn.style.opacity = this.historyIndex >= this.historyStack.length - 1 ? '0.4' : '1';
        }
        if (this.upBtn) {
            const canGoUp = this.currentPath !== '/' && this.currentPath.length > 0;
            this.upBtn.disabled = !canGoUp;
            this.upBtn.style.opacity = !canGoUp ? '0.4' : '1';
        }
    }

    private createModalDOM(): void {
        const overlay = document.createElement('div');
        overlay.className = 'hfb-overlay';
        this.modalEl = overlay;

        overlay.addEventListener('keydown', (e) => this.handleKeyDown(e));

        const box = document.createElement('div');
        box.className = 'hfb-modal-box';
        box.tabIndex = 0; // for keyboard focus
        overlay.appendChild(box);

        // Header
        const header = document.createElement('div');
        header.className = 'hfb-header';

        const title = document.createElement('div');
        title.className = 'hfb-title';
        title.innerHTML = `<span class="hfb-title-icon">📂</span><span>${this.titleText}</span>`;
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'hfb-close-btn';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Close (Esc)';
        closeBtn.onclick = () => this.close();
        header.appendChild(closeBtn);
        box.appendChild(header);

        // Main Navigation Bar (Back, Fwd, Up, Refresh, Breadcrumb / Address Bar)
        const navBar = document.createElement('div');
        navBar.className = 'hfb-nav-bar';

        const navControls = document.createElement('div');
        navControls.className = 'hfb-nav-controls';

        this.backBtn = document.createElement('button');
        this.backBtn.className = 'hfb-nav-btn';
        this.backBtn.innerHTML = '◀';
        this.backBtn.title = 'Back';
        this.backBtn.onclick = () => this.navBack();
        navControls.appendChild(this.backBtn);

        this.fwdBtn = document.createElement('button');
        this.fwdBtn.className = 'hfb-nav-btn';
        this.fwdBtn.innerHTML = '▶';
        this.fwdBtn.title = 'Forward';
        this.fwdBtn.onclick = () => this.navForward();
        navControls.appendChild(this.fwdBtn);

        this.upBtn = document.createElement('button');
        this.upBtn.className = 'hfb-nav-btn';
        this.upBtn.innerHTML = '▲';
        this.upBtn.title = 'Up to parent folder (Alt+Up)';
        this.upBtn.onclick = () => this.navUp();
        navControls.appendChild(this.upBtn);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'hfb-nav-btn';
        refreshBtn.innerHTML = '🔄';
        refreshBtn.title = 'Refresh current directory (F5)';
        refreshBtn.onclick = () => this.refresh();
        navControls.appendChild(refreshBtn);

        navBar.appendChild(navControls);

        // Address / Breadcrumbs Container
        this.addressBarContainer = document.createElement('div');
        this.addressBarContainer.className = 'hfb-address-bar-container';

        this.breadcrumbsContainer = document.createElement('div');
        this.breadcrumbsContainer.className = 'hfb-breadcrumbs';
        this.breadcrumbsContainer.title = 'Click path segment to jump, or double-click to edit path';
        this.breadcrumbsContainer.ondblclick = () => this.toggleAddressEditMode(true);

        const editPathBtn = document.createElement('button');
        editPathBtn.className = 'hfb-edit-path-btn';
        editPathBtn.innerHTML = '✎';
        editPathBtn.title = 'Type path directly';
        editPathBtn.onclick = () => this.toggleAddressEditMode(!this.addressEditMode);

        this.addressInput = document.createElement('input');
        this.addressInput.type = 'text';
        this.addressInput.className = 'hfb-address-input';
        this.addressInput.style.display = 'none';
        this.addressInput.placeholder = '/path/to/directory';
        this.addressInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const target = this.addressInput?.value.trim();
                if (target) {
                    this.navigate(target);
                    this.toggleAddressEditMode(false);
                }
            } else if (e.key === 'Escape') {
                this.toggleAddressEditMode(false);
            }
        };

        const goBtn = document.createElement('button');
        goBtn.className = 'hfb-go-btn';
        goBtn.textContent = 'Go';
        goBtn.style.display = 'none';
        goBtn.onclick = () => {
            const target = this.addressInput?.value.trim();
            if (target) {
                this.navigate(target);
                this.toggleAddressEditMode(false);
            }
        };

        this.addressBarContainer.appendChild(this.breadcrumbsContainer);
        this.addressBarContainer.appendChild(this.addressInput);
        this.addressBarContainer.appendChild(editPathBtn);
        this.addressBarContainer.appendChild(goBtn);
        navBar.appendChild(this.addressBarContainer);

        box.appendChild(navBar);

        // Filter / Search Toolbar
        const filterToolbar = document.createElement('div');
        filterToolbar.className = 'hfb-filter-toolbar';

        // Search Input (Supports wildcards, e.g. *.k, *box*, cylinder)
        const searchWrapper = document.createElement('div');
        searchWrapper.className = 'hfb-search-wrapper';
        searchWrapper.title = 'Filter files by wildcard pattern (*.k, *.json, *test*) or text';

        const searchIcon = document.createElement('span');
        searchIcon.className = 'hfb-search-icon';
        searchIcon.textContent = '🔍';
        searchWrapper.appendChild(searchIcon);

        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'hfb-search-input';
        this.searchInput.placeholder = 'Filter files (wildcard: *.k, *box*, etc.)...';
        this.searchInput.oninput = () => {
            this.searchFilter = this.searchInput?.value.trim() || '';
            this.applyFilterAndRender();
        };
        searchWrapper.appendChild(this.searchInput);

        const clearSearchBtn = document.createElement('button');
        clearSearchBtn.className = 'hfb-clear-search-btn';
        clearSearchBtn.innerHTML = '✕';
        clearSearchBtn.title = 'Clear search filter';
        clearSearchBtn.onclick = () => {
            if (this.searchInput) this.searchInput.value = '';
            this.searchFilter = '';
            this.applyFilterAndRender();
        };
        searchWrapper.appendChild(clearSearchBtn);
        filterToolbar.appendChild(searchWrapper);

        // Filter Presets Selector
        const presetSelect = document.createElement('select');
        presetSelect.className = 'hfb-select hfb-preset-select';
        presetSelect.title = 'Filter by file format';
        this.filterPresets.forEach((p, idx) => {
            const opt = document.createElement('option');
            opt.value = idx.toString();
            opt.textContent = p.label;
            if (idx === this.selectedFilterPresetIndex) opt.selected = true;
            presetSelect.appendChild(opt);
        });
        presetSelect.onchange = () => {
            const idx = parseInt(presetSelect.value, 10);
            this.selectedFilterPresetIndex = idx;
            this.activeExtensionFilter = this.filterPresets[idx].extensions;
            this.applyFilterAndRender();
        };
        this.filterSelectEl = presetSelect;
        filterToolbar.appendChild(presetSelect);

        // Type filter pills (All / Files / Folders)
        const typeFilterWrap = document.createElement('div');
        typeFilterWrap.className = 'hfb-type-filter-group';

        const types: { id: ItemTypeFilter; label: string }[] = [
            { id: 'all', label: 'All' },
            { id: 'files', label: 'Files' },
            { id: 'folders', label: 'Folders' }
        ];

        types.forEach(t => {
            const btn = document.createElement('button');
            btn.className = `hfb-type-btn ${this.itemTypeFilter === t.id ? 'active' : ''}`;
            btn.textContent = t.label;
            btn.onclick = () => {
                this.itemTypeFilter = t.id;
                typeFilterWrap.querySelectorAll('.hfb-type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.applyFilterAndRender();
            };
            typeFilterWrap.appendChild(btn);
        });
        filterToolbar.appendChild(typeFilterWrap);

        // Toggle Hidden Files
        const hiddenBtn = document.createElement('button');
        hiddenBtn.className = `hfb-pill-btn ${this.showHidden ? 'active' : ''}`;
        hiddenBtn.textContent = '👁 Hidden';
        hiddenBtn.title = 'Toggle hidden dotfiles (.*)';
        hiddenBtn.onclick = () => {
            this.showHidden = !this.showHidden;
            hiddenBtn.classList.toggle('active', this.showHidden);
            this.applyFilterAndRender();
        };
        filterToolbar.appendChild(hiddenBtn);

        box.appendChild(filterToolbar);

        // Middle Body Layout: Quick Places Sidebar + File Table
        const bodyContainer = document.createElement('div');
        bodyContainer.className = 'hfb-body-container';

        // Quick Places Sidebar
        const sidebar = document.createElement('div');
        sidebar.className = 'hfb-sidebar';

        const sidebarTitle = document.createElement('div');
        sidebarTitle.className = 'hfb-sidebar-heading';
        sidebarTitle.textContent = 'QUICK ACCESS';
        sidebar.appendChild(sidebarTitle);

        const shortcuts: { name: string; icon: string; path: string }[] = [
            { name: 'BlastDemon Root', icon: '⚡', path: this.projectPath },
            { name: 'Scratch / Tests', icon: '🧪', path: `${this.projectPath}/scratch` },
            { name: 'Build / Binaries', icon: '📦', path: `${this.projectPath}/build` },
            { name: 'Frontend App', icon: '🌐', path: `${this.projectPath}/frontend` },
            { name: 'Home Directory', icon: '🏠', path: this.homePath },
            { name: 'Root FileSystem', icon: '💾', path: '/' }
        ];

        shortcuts.forEach(s => {
            const item = document.createElement('div');
            item.className = 'hfb-shortcut-item';
            item.innerHTML = `<span class="hfb-shortcut-icon">${s.icon}</span><span class="hfb-shortcut-name">${s.name}</span>`;
            item.title = s.path;
            item.onclick = () => this.navigate(s.path);
            sidebar.appendChild(item);
        });

        bodyContainer.appendChild(sidebar);

        // List Container (Table with Sortable Columns)
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'hfb-list-container';

        // Loading Overlay
        this.loadingEl = document.createElement('div');
        this.loadingEl.className = 'hfb-loading-indicator';
        this.loadingEl.innerHTML = `<div class="hfb-spinner"></div><span>Scanning directory...</span>`;
        this.listContainer.appendChild(this.loadingEl);

        const table = document.createElement('table');
        table.className = 'hfb-file-table';

        // Header Row with Sort indicators
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const cols: { key: SortKey; label: string; width?: string }[] = [
            { key: 'name', label: 'Name' },
            { key: 'type', label: 'Type', width: '140px' },
            { key: 'size', label: 'Size', width: '90px' },
            { key: 'mtime', label: 'Modified', width: '140px' }
        ];

        cols.forEach(c => {
            const th = document.createElement('th');
            th.className = `hfb-th hfb-th-${c.key} ${this.sortKey === c.key ? 'sorted' : ''}`;
            if (c.width) th.style.width = c.width;
            
            const labelSpan = document.createElement('span');
            labelSpan.textContent = c.label;
            th.appendChild(labelSpan);

            const sortArrow = document.createElement('span');
            sortArrow.className = 'hfb-sort-arrow';
            sortArrow.textContent = this.sortKey === c.key ? (this.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            th.appendChild(sortArrow);

            th.onclick = () => this.toggleSort(c.key);
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        this.tableBodyEl = document.createElement('tbody');
        this.tableBodyEl.className = 'hfb-table-body';
        table.appendChild(this.tableBodyEl);

        this.listContainer.appendChild(table);
        bodyContainer.appendChild(this.listContainer);

        box.appendChild(bodyContainer);

        // Footer Section
        const footer = document.createElement('div');
        footer.className = 'hfb-footer';

        // Left Footer: New Folder & Item Count
        const leftFooter = document.createElement('div');
        leftFooter.className = 'hfb-footer-left';

        const newFolderBtn = document.createElement('button');
        newFolderBtn.className = 'hfb-btn hfb-btn-secondary';
        newFolderBtn.innerHTML = '<span>+</span> New Folder';
        newFolderBtn.title = 'Create a new directory';
        newFolderBtn.onclick = async () => {
            const folderName = await CustomDialog.prompt("Enter new folder name:");
            if (folderName && folderName.trim()) {
                const newPath = this.currentPath === '/' ? `/${folderName.trim()}` : `${this.currentPath}/${folderName.trim()}`;
                if (this.networkManager) {
                    this.networkManager.send({
                        command: "CREATE_DIR",
                        path: newPath
                    });
                }
            }
        };
        leftFooter.appendChild(newFolderBtn);

        this.statusTextEl = document.createElement('span');
        this.statusTextEl.className = 'hfb-status-text';
        this.statusTextEl.textContent = 'Loading...';
        leftFooter.appendChild(this.statusTextEl);
        footer.appendChild(leftFooter);

        // Right Footer: Filename, Extension selector & Action Buttons
        const rightFooter = document.createElement('div');
        rightFooter.className = 'hfb-footer-right';

        const fileLabel = document.createElement('span');
        fileLabel.className = 'hfb-footer-label';
        fileLabel.textContent = this.selectFolderOnly ? 'Folder:' : 'Filename:';
        rightFooter.appendChild(fileLabel);

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'text';
        this.fileInput.className = 'hfb-filename-input';
        this.fileInput.value = this.defaultFilename;
        this.fileInput.placeholder = this.selectFolderOnly ? 'Current Folder' : 'select_file';
        this.fileInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.confirmSelection();
            }
        };
        rightFooter.appendChild(this.fileInput);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'hfb-btn hfb-btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => this.close();
        rightFooter.appendChild(cancelBtn);

        const actionBtn = document.createElement('button');
        actionBtn.className = 'hfb-btn hfb-btn-primary';
        actionBtn.textContent = this.selectFolderOnly ? 'Select Folder' : (this.mode === 'open' ? 'Open' : 'Save');
        actionBtn.onclick = () => this.confirmSelection();
        rightFooter.appendChild(actionBtn);

        footer.appendChild(rightFooter);
        box.appendChild(footer);

        document.body.appendChild(overlay);
        box.focus();
    }

    private toggleAddressEditMode(editing: boolean): void {
        this.addressEditMode = editing;
        if (this.breadcrumbsContainer) {
            this.breadcrumbsContainer.style.display = editing ? 'none' : 'flex';
        }
        if (this.addressInput) {
            this.addressInput.style.display = editing ? 'block' : 'none';
            if (editing) {
                this.addressInput.value = this.currentPath;
                this.addressInput.focus();
                this.addressInput.select();
            }
        }
        const goBtn = this.addressBarContainer?.querySelector('.hfb-go-btn') as HTMLElement;
        if (goBtn) {
            goBtn.style.display = editing ? 'block' : 'none';
        }
    }

    private renderBreadcrumbs(): void {
        if (!this.breadcrumbsContainer) return;
        this.breadcrumbsContainer.innerHTML = '';

        if (!this.currentPath) {
            const rootCrumb = document.createElement('span');
            rootCrumb.className = 'hfb-crumb';
            rootCrumb.textContent = '/';
            rootCrumb.onclick = () => this.navigate('/');
            this.breadcrumbsContainer.appendChild(rootCrumb);
            return;
        }

        const segments = this.currentPath.split('/').filter(s => s.length > 0);
        
        // Root Segment
        const rootCrumb = document.createElement('span');
        rootCrumb.className = 'hfb-crumb hfb-root-crumb';
        rootCrumb.textContent = 'root';
        rootCrumb.title = 'Root filesystem (/)';
        rootCrumb.onclick = () => this.navigate('/');
        this.breadcrumbsContainer.appendChild(rootCrumb);

        let accumulated = '';
        segments.forEach((seg, idx) => {
            const sep = document.createElement('span');
            sep.className = 'hfb-crumb-sep';
            sep.textContent = '/';
            this.breadcrumbsContainer?.appendChild(sep);

            accumulated += '/' + seg;
            const targetPath = accumulated;

            const crumb = document.createElement('span');
            crumb.className = `hfb-crumb ${idx === segments.length - 1 ? 'hfb-crumb-current' : ''}`;
            crumb.textContent = seg;
            crumb.title = targetPath;
            crumb.onclick = () => this.navigate(targetPath);
            this.breadcrumbsContainer?.appendChild(crumb);
        });
    }

    private toggleSort(key: SortKey): void {
        if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortKey = key;
            this.sortDir = (key === 'size' || key === 'mtime') ? 'desc' : 'asc';
        }
        this.updateTableHeaderSortIcons();
        this.applyFilterAndRender();
    }

    private updateTableHeaderSortIcons(): void {
        if (!this.listContainer) return;
        const ths = this.listContainer.querySelectorAll<HTMLTableCellElement>('.hfb-th');
        ths.forEach(th => {
            const isCurrent = th.classList.contains(`hfb-th-${this.sortKey}`);
            th.classList.toggle('sorted', isCurrent);
            const arrow = th.querySelector('.hfb-sort-arrow');
            if (arrow) {
                arrow.textContent = isCurrent ? (this.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            }
        });
    }

    /**
     * Test if a filename matches wildcard glob pattern (*, ?, comma-separated)
     */
    private matchesWildcard(name: string, pattern: string): boolean {
        if (!pattern || pattern === '*' || pattern === '*.*') return true;
        
        // Handle comma or semicolon separated patterns
        const subPatterns = pattern.split(/[,;]+/).map(p => p.trim()).filter(p => p.length > 0);
        if (subPatterns.length > 1) {
            return subPatterns.some(p => this.matchesWildcard(name, p));
        }

        const pat = subPatterns[0] || pattern;
        // Convert wildcard glob pattern to Regex
        // Escape regex special chars except * and ?
        const regexStr = '^' + pat
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$';

        try {
            const regex = new RegExp(regexStr, 'i');
            return regex.test(name);
        } catch {
            // Fallback to simple substring
            return name.toLowerCase().includes(pat.toLowerCase());
        }
    }

    private applyFilterAndRender(): void {
        let entries = [...this.rawEntries];

        // 1. Hidden files filter
        if (!this.showHidden) {
            entries = entries.filter(e => !e.name.startsWith('.') || (this.searchFilter && e.name.toLowerCase().includes(this.searchFilter.toLowerCase())));
        }

        // 2. Item Type Filter (All / Files / Folders)
        if (this.itemTypeFilter === 'files') {
            entries = entries.filter(e => !e.isDir);
        } else if (this.itemTypeFilter === 'folders') {
            entries = entries.filter(e => e.isDir);
        }

        // 3. Extension Presets Filter (Only applied to files; folders remain visible)
        if (this.activeExtensionFilter && !this.activeExtensionFilter.includes('*')) {
            entries = entries.filter(e => {
                if (e.isDir) return true;
                const ext = (e.ext || '').toLowerCase();
                const fname = e.name.toLowerCase();
                return this.activeExtensionFilter.some(allowed => {
                    const cleanExt = allowed.toLowerCase().startsWith('.') ? allowed.toLowerCase() : `.${allowed.toLowerCase()}`;
                    return ext === cleanExt || fname.endsWith(cleanExt);
                });
            });
        }

        // 4. Search Filter (Wildcard / Substring)
        if (this.searchFilter) {
            const filterStr = this.searchFilter.trim();
            entries = entries.filter(e => {
                if (filterStr.includes('*') || filterStr.includes('?')) {
                    return this.matchesWildcard(e.name, filterStr);
                }
                return e.name.toLowerCase().includes(filterStr.toLowerCase()) || 
                       (e.type && e.type.toLowerCase().includes(filterStr.toLowerCase()));
            });
        }

        // 5. Sorting
        entries.sort((a, b) => {
            // Folders first if enabled
            if (this.foldersFirst) {
                if (a.isDir && !b.isDir) return -1;
                if (!a.isDir && b.isDir) return 1;
            }

            let cmp = 0;
            switch (this.sortKey) {
                case 'name':
                    cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
                    break;
                case 'type':
                    const typeA = a.isDir ? '000_folder' : (a.type || a.ext || 'zzz');
                    const typeB = b.isDir ? '000_folder' : (b.type || b.ext || 'zzz');
                    cmp = typeA.localeCompare(typeB);
                    break;
                case 'size':
                    cmp = (a.size || 0) - (b.size || 0);
                    break;
                case 'mtime':
                    cmp = (a.mtime || 0) - (b.mtime || 0);
                    break;
            }

            return this.sortDir === 'asc' ? cmp : -cmp;
        });

        this.displayedEntries = entries;
        this.renderTable();
        this.updateStatusText();
    }

    private renderTable(): void {
        if (!this.tableBodyEl) return;
        this.tableBodyEl.innerHTML = '';
        this.selectedRowIndex = -1;

        if (this.displayedEntries.length === 0) {
            const emptyRow = document.createElement('tr');
            emptyRow.className = 'hfb-empty-row';
            const td = document.createElement('td');
            td.colSpan = 4;
            td.className = 'hfb-empty-cell';

            if (this.searchFilter || (this.activeExtensionFilter && !this.activeExtensionFilter.includes('*'))) {
                td.innerHTML = `
                    <div class="hfb-empty-icon">🔍</div>
                    <div class="hfb-empty-title">No files matching active filter</div>
                    <div class="hfb-empty-subtitle">Try adjusting your search wildcard or changing the format dropdown.</div>
                `;
            } else {
                td.innerHTML = `
                    <div class="hfb-empty-icon">📂</div>
                    <div class="hfb-empty-title">This folder is empty</div>
                `;
            }
            emptyRow.appendChild(td);
            this.tableBodyEl.appendChild(emptyRow);
            return;
        }

        this.displayedEntries.forEach((entry, idx) => {
            const row = document.createElement('tr');
            row.className = `hfb-row ${entry.isDir ? 'hfb-dir-row' : 'hfb-file-row'}`;
            if (this.selectedFilename === entry.name) {
                row.classList.add('selected');
                this.selectedRowIndex = idx;
            }

            // Column 1: Icon + Name
            const nameTd = document.createElement('td');
            nameTd.className = 'hfb-td hfb-td-name';
            
            const iconSpan = document.createElement('span');
            iconSpan.className = 'hfb-file-icon';
            iconSpan.textContent = this.getFileIcon(entry);
            nameTd.appendChild(iconSpan);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'hfb-file-label';
            nameSpan.textContent = entry.name;
            if (entry.isSymlink) {
                const linkBadge = document.createElement('span');
                linkBadge.className = 'hfb-symlink-badge';
                linkBadge.textContent = ' ↗';
                linkBadge.title = 'Symbolic link';
                nameSpan.appendChild(linkBadge);
            }
            nameTd.appendChild(nameSpan);
            row.appendChild(nameTd);

            // Column 2: Type
            const typeTd = document.createElement('td');
            typeTd.className = 'hfb-td hfb-td-type';
            typeTd.textContent = entry.isDir ? 'Folder' : (entry.type || this.getTypeDescription(entry.name));
            row.appendChild(typeTd);

            // Column 3: Size
            const sizeTd = document.createElement('td');
            sizeTd.className = 'hfb-td hfb-td-size';
            sizeTd.textContent = entry.isDir ? '—' : this.formatFileSize(entry.size);
            row.appendChild(sizeTd);

            // Column 4: Modified Date
            const mtimeTd = document.createElement('td');
            mtimeTd.className = 'hfb-td hfb-td-mtime';
            mtimeTd.textContent = this.formatDate(entry.mtime);
            row.appendChild(mtimeTd);

            // Row Interaction
            row.onclick = (e) => {
                e.stopPropagation();
                this.selectRow(idx, entry);
            };

            row.ondblclick = (e) => {
                e.stopPropagation();
                if (entry.isDir) {
                    const next = this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
                    this.navigate(next);
                } else {
                    this.selectedFilename = entry.name;
                    if (this.fileInput) this.fileInput.value = entry.name;
                    this.confirmSelection();
                }
            };

            this.tableBodyEl?.appendChild(row);
        });
    }

    private selectRow(index: number, entry: FileEntry): void {
        if (!this.tableBodyEl) return;
        const rows = this.tableBodyEl.querySelectorAll('.hfb-row');
        rows.forEach(r => r.classList.remove('selected'));

        if (index >= 0 && index < rows.length) {
            rows[index].classList.add('selected');
            this.selectedRowIndex = index;
            this.selectedFilename = entry.name;

            if (this.fileInput) {
                if (!entry.isDir || this.selectFolderOnly) {
                    this.fileInput.value = entry.name;
                }
            }
            this.updateStatusText();
        }
    }

    private getFileIcon(entry: FileEntry): string {
        if (entry.isDir) return '📁';
        const name = entry.name.toLowerCase();
        if (name.endsWith('.json')) return '⚙️';
        if (name.endsWith('.k') || name.endsWith('.key') || name.endsWith('.dyn')) return '📜';
        if (name.endsWith('.stl')) return '🧊';
        if (name.endsWith('.h5') || name.endsWith('.hdf5') || name.endsWith('.xdmf') || name.endsWith('.xmf')) return '📊';
        if (name.endsWith('.cpp') || name.endsWith('.cu') || name.endsWith('.c') || name.endsWith('.h') || name.endsWith('.hpp')) return '⚡';
        if (name.endsWith('.py')) return '🐍';
        if (name.endsWith('.ts') || name.endsWith('.js')) return '🟨';
        if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.log')) return '📄';
        if (name.endsWith('.csv') || name.endsWith('.dat')) return '📈';
        if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.svg')) return '🖼️';
        if (name.endsWith('.zip') || name.endsWith('.tar') || name.endsWith('.gz')) return '📦';
        return '📄';
    }

    private getTypeDescription(filename: string): string {
        const name = filename.toLowerCase();
        if (name.endsWith('.json')) return 'JSON Model';
        if (name.endsWith('.k') || name.endsWith('.key') || name.endsWith('.dyn')) return 'LS-DYNA Keyword';
        if (name.endsWith('.stl')) return 'STL 3D Geometry';
        if (name.endsWith('.h5') || name.endsWith('.hdf5')) return 'HDF5 Data';
        if (name.endsWith('.xdmf') || name.endsWith('.xmf')) return 'XDMF Grid';
        if (name.endsWith('.cpp') || name.endsWith('.cc')) return 'C++ Source';
        if (name.endsWith('.cu')) return 'CUDA Source';
        if (name.endsWith('.py')) return 'Python Script';
        if (name.endsWith('.ts')) return 'TypeScript';
        if (name.endsWith('.txt')) return 'Plain Text';
        if (name.endsWith('.csv')) return 'CSV Data';
        return 'File';
    }

    private formatFileSize(bytes: number): string {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i <= 0) return `${bytes} B`;
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    private formatDate(seconds?: number): string {
        if (!seconds || seconds <= 0) return '—';
        const d = new Date(seconds * 1000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }

    private updateStatusText(): void {
        if (!this.statusTextEl) return;
        const total = this.rawEntries.length;
        const shown = this.displayedEntries.length;
        const folderCount = this.displayedEntries.filter(e => e.isDir).length;
        const fileCount = shown - folderCount;

        let status = `${shown} items (${folderCount} folders, ${fileCount} files)`;
        if (shown !== total) {
            status += ` | Filtered from ${total}`;
        }
        if (this.selectedFilename) {
            const selEntry = this.displayedEntries.find(e => e.name === this.selectedFilename);
            if (selEntry && !selEntry.isDir) {
                status += ` | Selected: ${selEntry.name} (${this.formatFileSize(selEntry.size)})`;
            } else if (selEntry) {
                status += ` | Selected: ${selEntry.name} (Folder)`;
            }
        }
        this.statusTextEl.textContent = status;
    }

    private handleKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            this.close();
            return;
        }

        // If focus is in text input, don't intercept up/down arrow keys
        const activeTag = document.activeElement?.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'select') {
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (this.displayedEntries.length > 0) {
                const nextIdx = Math.min(this.selectedRowIndex + 1, this.displayedEntries.length - 1);
                this.selectRow(nextIdx, this.displayedEntries[nextIdx]);
                this.scrollSelectedIntoView();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (this.displayedEntries.length > 0) {
                const prevIdx = Math.max(this.selectedRowIndex - 1, 0);
                this.selectRow(prevIdx, this.displayedEntries[prevIdx]);
                this.scrollSelectedIntoView();
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.selectedRowIndex >= 0 && this.selectedRowIndex < this.displayedEntries.length) {
                const entry = this.displayedEntries[this.selectedRowIndex];
                if (entry.isDir) {
                    const next = this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
                    this.navigate(next);
                } else {
                    this.confirmSelection();
                }
            } else {
                this.confirmSelection();
            }
        } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
            e.preventDefault();
            this.navUp();
        } else if (e.key === 'F5') {
            e.preventDefault();
            this.refresh();
        }
    }

    private scrollSelectedIntoView(): void {
        if (!this.tableBodyEl || this.selectedRowIndex < 0) return;
        const rows = this.tableBodyEl.querySelectorAll('.hfb-row');
        if (this.selectedRowIndex < rows.length) {
            rows[this.selectedRowIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    private async confirmSelection(): Promise<void> {
        if (this.selectFolderOnly) {
            const folder = this.fileInput?.value.trim();
            let selectedFolder = this.currentPath;
            if (folder && folder !== '.' && folder !== 'select_dir') {
                const matched = this.displayedEntries.find(e => e.isDir && e.name === folder);
                if (matched) {
                    selectedFolder = this.currentPath === '/' ? `/${matched.name}` : `${this.currentPath}/${matched.name}`;
                }
            }
            this.onSelectCallback(selectedFolder);
            this.close();
            return;
        }

        const fileName = this.fileInput?.value.trim();
        if (!fileName) {
            await CustomDialog.alert("Please enter or select a filename.");
            return;
        }

        let fullPath = this.currentPath === '/' ? `/${fileName}` : `${this.currentPath}/${fileName}`;
        
        // In save mode, if no extension is present and an extension filter is selected, append it
        if (this.mode === 'save' && !fileName.includes('.')) {
            if (this.activeExtensionFilter && !this.activeExtensionFilter.includes('*') && this.activeExtensionFilter.length > 0) {
                const defaultExt = this.activeExtensionFilter[0];
                fullPath += defaultExt.startsWith('.') ? defaultExt : `.${defaultExt}`;
            }
        }

        this.onSelectCallback(fullPath);
        this.close();
    }

    private showLoading(): void {
        if (this.loadingEl) this.loadingEl.style.display = 'flex';
    }

    private hideLoading(): void {
        if (this.loadingEl) this.loadingEl.style.display = 'none';
    }

    private showErrorBanner(msg: string): void {
        this.hideLoading();
        let banner = this.modalEl?.querySelector('.hfb-error-banner') as HTMLDivElement;
        if (!banner && this.modalEl) {
            banner = document.createElement('div');
            banner.className = 'hfb-error-banner';
            const modalBox = this.modalEl.querySelector('.hfb-modal-box');
            modalBox?.insertBefore(banner, modalBox.children[1]);
        }
        if (banner) {
            banner.textContent = msg;
            banner.style.display = 'block';
        }
    }

    private hideErrorBanner(): void {
        const banner = this.modalEl?.querySelector('.hfb-error-banner') as HTMLDivElement;
        if (banner) {
            banner.style.display = 'none';
        }
    }

    private injectStyles(): void {
        const id = 'hfb-modern-styles';
        if (document.getElementById(id)) return;

        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
            .hfb-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(8, 8, 12, 0.75);
                backdrop-filter: blur(10px);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: hfb-fade-in 0.15s ease-out;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
            }

            .hfb-modal-box {
                width: 860px;
                max-width: 95vw;
                height: 580px;
                max-height: 90vh;
                background: #18181c;
                border: 1px solid #33333d;
                border-radius: 8px;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7), 0 0 1px 1px rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                color: #e0e0e6;
                overflow: hidden;
                outline: none;
            }

            .hfb-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 16px;
                background: #1f1f26;
                border-bottom: 1px solid #2d2d38;
                user-select: none;
            }

            .hfb-title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                font-weight: 600;
                color: #00f0ff;
                letter-spacing: 0.3px;
                text-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
            }

            .hfb-title-icon {
                font-size: 16px;
            }

            .hfb-close-btn {
                background: transparent;
                border: none;
                color: #888;
                font-size: 14px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                transition: all 0.15s ease;
            }
            .hfb-close-btn:hover {
                color: #ff5555;
                background: rgba(255, 85, 85, 0.15);
            }

            .hfb-error-banner {
                background: #4a1515;
                border-bottom: 1px solid #752020;
                color: #ffb4b4;
                padding: 8px 16px;
                font-size: 12px;
                display: none;
            }

            .hfb-nav-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 14px;
                background: #151519;
                border-bottom: 1px solid #282832;
            }

            .hfb-nav-controls {
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .hfb-nav-btn {
                background: #23232c;
                border: 1px solid #363644;
                color: #bbb;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.12s ease;
            }
            .hfb-nav-btn:hover:not(:disabled) {
                background: #323240;
                color: #00f0ff;
                border-color: #00f0ff;
            }

            .hfb-address-bar-container {
                flex: 1;
                display: flex;
                align-items: center;
                background: #1d1d25;
                border: 1px solid #363644;
                border-radius: 4px;
                padding: 2px 8px;
                min-height: 28px;
                overflow: hidden;
            }
            .hfb-address-bar-container:focus-within {
                border-color: #00f0ff;
                box-shadow: 0 0 6px rgba(0, 240, 255, 0.25);
            }

            .hfb-breadcrumbs {
                flex: 1;
                display: flex;
                align-items: center;
                flex-wrap: nowrap;
                overflow-x: auto;
                gap: 2px;
                font-size: 12px;
                user-select: none;
            }

            .hfb-crumb {
                padding: 2px 6px;
                border-radius: 3px;
                cursor: pointer;
                color: #bbb;
                white-space: nowrap;
                transition: background 0.12s;
            }
            .hfb-crumb:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }
            .hfb-crumb-current {
                color: #00f0ff;
                font-weight: 500;
            }
            .hfb-root-crumb {
                font-weight: 600;
                color: #888;
            }

            .hfb-crumb-sep {
                color: #555;
                user-select: none;
                padding: 0 2px;
            }

            .hfb-edit-path-btn {
                background: transparent;
                border: none;
                color: #777;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 3px;
                font-size: 12px;
                margin-left: 4px;
            }
            .hfb-edit-path-btn:hover {
                color: #00f0ff;
            }

            .hfb-address-input {
                flex: 1;
                background: transparent;
                border: none;
                color: #fff;
                font-size: 12px;
                outline: none;
                font-family: inherit;
            }

            .hfb-go-btn {
                background: #007acc;
                border: none;
                color: #fff;
                border-radius: 3px;
                padding: 2px 8px;
                font-size: 11px;
                cursor: pointer;
                margin-left: 4px;
            }

            .hfb-filter-toolbar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 14px;
                background: #18181f;
                border-bottom: 1px solid #282832;
                flex-wrap: wrap;
            }

            .hfb-search-wrapper {
                flex: 1;
                min-width: 200px;
                display: flex;
                align-items: center;
                background: #1f1f29;
                border: 1px solid #363644;
                border-radius: 4px;
                padding: 2px 8px;
                height: 26px;
            }
            .hfb-search-wrapper:focus-within {
                border-color: #00f0ff;
            }

            .hfb-search-icon {
                font-size: 12px;
                margin-right: 6px;
                color: #777;
            }

            .hfb-search-input {
                flex: 1;
                background: transparent;
                border: none;
                color: #fff;
                font-size: 11px;
                outline: none;
            }

            .hfb-clear-search-btn {
                background: transparent;
                border: none;
                color: #666;
                cursor: pointer;
                font-size: 10px;
                padding: 2px;
            }
            .hfb-clear-search-btn:hover {
                color: #ff5555;
            }

            .hfb-select {
                background: #1f1f29;
                border: 1px solid #363644;
                border-radius: 4px;
                color: #ccc;
                font-size: 11px;
                padding: 3px 6px;
                outline: none;
                cursor: pointer;
            }
            .hfb-select:focus {
                border-color: #00f0ff;
            }

            .hfb-type-filter-group {
                display: flex;
                border: 1px solid #363644;
                border-radius: 4px;
                overflow: hidden;
            }

            .hfb-type-btn {
                background: #1f1f29;
                border: none;
                border-right: 1px solid #363644;
                color: #888;
                font-size: 11px;
                padding: 3px 8px;
                cursor: pointer;
                transition: all 0.12s;
            }
            .hfb-type-btn:last-child {
                border-right: none;
            }
            .hfb-type-btn.active {
                background: #007acc;
                color: #fff;
                font-weight: 500;
            }

            .hfb-pill-btn {
                background: #1f1f29;
                border: 1px solid #363644;
                border-radius: 4px;
                color: #888;
                font-size: 11px;
                padding: 3px 8px;
                cursor: pointer;
                transition: all 0.12s;
            }
            .hfb-pill-btn.active {
                background: rgba(0, 240, 255, 0.15);
                color: #00f0ff;
                border-color: #00f0ff;
            }

            .hfb-body-container {
                flex: 1;
                display: flex;
                overflow: hidden;
            }

            .hfb-sidebar {
                width: 170px;
                background: #131317;
                border-right: 1px solid #282832;
                padding: 8px 6px;
                display: flex;
                flex-direction: column;
                gap: 2px;
                overflow-y: auto;
                user-select: none;
            }

            .hfb-sidebar-heading {
                font-size: 9px;
                font-weight: bold;
                color: #555;
                letter-spacing: 0.8px;
                padding: 6px 8px 4px 8px;
            }

            .hfb-shortcut-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 8px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                color: #aaa;
                transition: all 0.12s ease;
            }
            .hfb-shortcut-item:hover {
                background: rgba(255, 255, 255, 0.06);
                color: #fff;
            }

            .hfb-shortcut-icon {
                font-size: 14px;
            }

            .hfb-shortcut-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .hfb-list-container {
                flex: 1;
                overflow-y: auto;
                background: #16161b;
                position: relative;
            }

            .hfb-loading-indicator {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(22, 22, 27, 0.8);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 12px;
                font-size: 12px;
                color: #00f0ff;
                z-index: 10;
            }

            .hfb-spinner {
                width: 24px;
                height: 24px;
                border: 2px solid rgba(0, 240, 255, 0.2);
                border-top-color: #00f0ff;
                border-radius: 50%;
                animation: hfb-spin 0.6s linear infinite;
            }

            .hfb-file-table {
                width: 100%;
                border-collapse: collapse;
                table-layout: fixed;
                font-size: 12px;
            }

            .hfb-file-table thead {
                position: sticky;
                top: 0;
                background: #1b1b22;
                z-index: 2;
                border-bottom: 1px solid #30303c;
            }

            .hfb-th {
                text-align: left;
                padding: 6px 10px;
                color: #888;
                font-weight: 500;
                font-size: 11px;
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
                transition: color 0.12s;
            }
            .hfb-th:hover {
                color: #fff;
            }
            .hfb-th.sorted {
                color: #00f0ff;
            }

            .hfb-sort-arrow {
                font-size: 9px;
                color: #00f0ff;
            }

            .hfb-row {
                cursor: pointer;
                user-select: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.03);
                transition: background 0.1s ease;
            }
            .hfb-row:hover {
                background: rgba(255, 255, 255, 0.04);
            }
            .hfb-row.selected {
                background: rgba(0, 240, 255, 0.15) !important;
                outline: 1px solid rgba(0, 240, 255, 0.4);
            }

            .hfb-td {
                padding: 5px 10px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #ccc;
            }

            .hfb-td-name {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #eee;
            }

            .hfb-file-icon {
                font-size: 14px;
                flex-shrink: 0;
            }

            .hfb-file-label {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .hfb-symlink-badge {
                color: #00f0ff;
                font-size: 10px;
            }

            .hfb-td-type {
                color: #888;
                font-size: 11px;
            }

            .hfb-td-size {
                color: #999;
                font-size: 11px;
                font-variant-numeric: tabular-nums;
            }

            .hfb-td-mtime {
                color: #777;
                font-size: 11px;
                font-variant-numeric: tabular-nums;
            }

            .hfb-empty-row {
                height: 220px;
            }

            .hfb-empty-cell {
                text-align: center;
                vertical-align: middle;
                color: #666;
            }

            .hfb-empty-icon {
                font-size: 32px;
                margin-bottom: 8px;
                opacity: 0.5;
            }

            .hfb-empty-title {
                font-size: 13px;
                font-weight: 500;
                color: #888;
                margin-bottom: 4px;
            }

            .hfb-empty-subtitle {
                font-size: 11px;
                color: #555;
            }

            .hfb-footer {
                padding: 10px 16px;
                background: #1c1c24;
                border-top: 1px solid #2d2d38;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
            }

            .hfb-footer-left {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
                min-width: 220px;
            }

            .hfb-status-text {
                font-size: 11px;
                color: #888;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .hfb-footer-right {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .hfb-footer-label {
                font-size: 11px;
                color: #888;
                white-space: nowrap;
            }

            .hfb-filename-input {
                width: 170px;
                background: #141418;
                border: 1px solid #383846;
                border-radius: 4px;
                padding: 4px 8px;
                color: #fff;
                font-size: 11px;
                outline: none;
            }
            .hfb-filename-input:focus {
                border-color: #00f0ff;
                box-shadow: 0 0 6px rgba(0, 240, 255, 0.25);
            }

            .hfb-btn {
                padding: 5px 14px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 500;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 4px;
                outline: none;
                transition: all 0.12s ease;
            }

            .hfb-btn-primary {
                background: #007acc;
                border: 1px solid #0098ff;
                color: #fff;
            }
            .hfb-btn-primary:hover {
                background: #0098ff;
                box-shadow: 0 0 10px rgba(0, 152, 255, 0.4);
            }

            .hfb-btn-secondary {
                background: #23232c;
                border: 1px solid #363644;
                color: #ccc;
            }
            .hfb-btn-secondary:hover {
                background: #30303c;
                color: #fff;
                border-color: #555;
            }

            @keyframes hfb-fade-in {
                from { opacity: 0; transform: scale(0.98); }
                to { opacity: 1; transform: scale(1); }
            }

            @keyframes hfb-spin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }
}
