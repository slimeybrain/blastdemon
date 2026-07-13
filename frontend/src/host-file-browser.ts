import { NetworkManager } from './NetworkManager.js';
import { CustomDialog } from './custom-dialog.js';

export class HostFileBrowserModal {
    private networkManager: NetworkManager;
    private mode: 'open' | 'save';
    private onSelect: (path: string) => void;
    private currentPath: string = "";
    private selectedFilename: string = "";
    private defaultFilename: string = "";
    
    private modalEl: HTMLDivElement | null = null;
    private addressInput: HTMLInputElement | null = null;
    private listContainer: HTMLDivElement | null = null;
    private fileInput: HTMLInputElement | null = null;
    private messageCallback: ((data: string | ArrayBuffer) => void) | null = null;

    constructor(networkManager: NetworkManager, mode: 'open' | 'save', defaultFilename: string, onSelect: (path: string) => void) {
        this.networkManager = networkManager;
        this.mode = mode;
        this.defaultFilename = defaultFilename;
        this.onSelect = onSelect;
    }

    public open(startPath: string = ""): void {
        this.injectStyles();
        this.createModalDOM();
        
        // Setup network callback
        this.messageCallback = async (data: string | ArrayBuffer) => {
            if (typeof data === 'string') {
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'list_dir_response') {
                        if (msg.status === 'success') {
                            this.currentPath = msg.currentPath;
                            if (this.addressInput) this.addressInput.value = this.currentPath;
                            this.renderEntries(msg.entries);
                        } else {
                            await CustomDialog.alert("Error listing directory: " + msg.error);
                        }
                    } else if (msg.type === 'create_dir_response') {
                        if (msg.status === 'success') {
                            this.refresh();
                        } else {
                            await CustomDialog.alert("Failed to create directory: " + msg.error);
                        }
                    }
                } catch(e) {}
            }
        };
        this.networkManager.onMessage(this.messageCallback);

        // Fetch initial directory
        // If startPath is empty or relative, let Broker resolve it.
        // If startPath is a file (e.g. /home/chris/model.json), use parent folder.
        let targetPath = startPath;
        if (startPath && startPath.includes('.')) {
            const lastSlash = startPath.lastIndexOf('/');
            if (lastSlash !== -1) {
                targetPath = startPath.substring(0, lastSlash);
            }
        }

        this.networkManager.send({
            command: "LIST_DIR",
            path: targetPath || "/home/chris/antigrav/blastdemon"
        });
    }

    private close(): void {
        if (this.messageCallback) {
            this.networkManager.offMessage(this.messageCallback);
            this.messageCallback = null;
        }
        if (this.modalEl) {
            this.modalEl.remove();
            this.modalEl = null;
        }
    }

    private refresh(): void {
        this.networkManager.send({
            command: "LIST_DIR",
            path: this.currentPath
        });
    }

    private createModalDOM(): void {
        // Modal Overlay
        const overlay = document.createElement('div');
        overlay.className = 'hfb-modal-overlay';
        this.modalEl = overlay;

        // Modal Box
        const box = document.createElement('div');
        box.className = 'hfb-modal-box';
        overlay.appendChild(box);

        // Title
        const titleEl = document.createElement('div');
        titleEl.className = 'hfb-modal-title';
        titleEl.textContent = this.mode === 'open' ? 'Open Model File (Host)' : 'Save Model As (Host)';
        box.appendChild(titleEl);

        // Toolbar: Address Bar & Up Button
        const toolbar = document.createElement('div');
        toolbar.className = 'hfb-toolbar';

        const upBtn = document.createElement('button');
        upBtn.className = 'hfb-btn hfb-up-btn';
        upBtn.innerHTML = '📂 <span>..</span>';
        upBtn.title = 'Go to parent directory';
        upBtn.onclick = () => {
            const lastSlash = this.currentPath.lastIndexOf('/');
            if (lastSlash > 0) {
                const parent = this.currentPath.substring(0, lastSlash);
                this.networkManager.send({ command: "LIST_DIR", path: parent });
            } else if (lastSlash === 0) {
                this.networkManager.send({ command: "LIST_DIR", path: "/" });
            }
        };
        toolbar.appendChild(upBtn);

        const addr = document.createElement('input');
        addr.type = 'text';
        addr.className = 'hfb-address-input';
        addr.value = this.currentPath;
        addr.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.networkManager.send({ command: "LIST_DIR", path: addr.value });
            }
        };
        this.addressInput = addr;
        toolbar.appendChild(addr);

        const goBtn = document.createElement('button');
        goBtn.className = 'hfb-btn';
        goBtn.textContent = 'Go';
        goBtn.onclick = () => {
            this.networkManager.send({ command: "LIST_DIR", path: addr.value });
        };
        toolbar.appendChild(goBtn);
        box.appendChild(toolbar);

        // List Container
        const list = document.createElement('div');
        list.className = 'hfb-list-container';
        this.listContainer = list;
        box.appendChild(list);

        // Footer / Actions
        const footer = document.createElement('div');
        footer.className = 'hfb-footer';

        const leftFooter = document.createElement('div');
        leftFooter.style.display = 'flex';
        leftFooter.style.gap = '8px';
        leftFooter.style.flex = '1';

        const newFolderBtn = document.createElement('button');
        newFolderBtn.className = 'hfb-btn secondary-btn';
        newFolderBtn.textContent = '+ New Folder';
        newFolderBtn.onclick = async () => {
            const name = await CustomDialog.prompt("Enter new folder name:");
            if (name && name.trim()) {
                const path = this.currentPath + "/" + name.trim();
                this.networkManager.send({ command: "CREATE_DIR", path: path });
            }
        };
        leftFooter.appendChild(newFolderBtn);
        footer.appendChild(leftFooter);

        const rightFooter = document.createElement('div');
        rightFooter.style.display = 'flex';
        rightFooter.style.alignItems = 'center';
        rightFooter.style.gap = '8px';

        // Filename Input (in save mode or loaded display)
        const fileLabel = document.createElement('span');
        fileLabel.className = 'hfb-label';
        fileLabel.textContent = 'Filename:';
        rightFooter.appendChild(fileLabel);

        const fileIn = document.createElement('input');
        fileIn.type = 'text';
        fileIn.className = 'hfb-file-input';
        fileIn.value = this.defaultFilename || 'model.json';
        if (this.mode === 'open') {
            fileIn.readOnly = true;
            fileIn.style.opacity = '0.7';
        }
        this.fileInput = fileIn;
        rightFooter.appendChild(fileIn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'hfb-btn secondary-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => this.close();
        rightFooter.appendChild(cancelBtn);

        const actionBtn = document.createElement('button');
        actionBtn.className = 'hfb-btn primary-btn';
        actionBtn.textContent = this.mode === 'open' ? 'Open' : 'Save';
        actionBtn.onclick = async () => {
            const file = fileIn.value.trim();
            if (!file) {
                await CustomDialog.alert("Please enter or select a file name.");
                return;
            }
            const fullPath = this.currentPath + "/" + file;
            this.onSelect(fullPath);
            this.close();
        };
        rightFooter.appendChild(actionBtn);

        footer.appendChild(rightFooter);
        box.appendChild(footer);

        document.body.appendChild(overlay);
    }

    private renderEntries(entries: { name: string, isDir: boolean, size: number }[]): void {
        if (!this.listContainer) return;
        this.listContainer.innerHTML = '';

        // Sort: directories first, then files, alphabetically
        const sorted = [...entries].sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name);
        });

        if (sorted.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'hfb-empty';
            empty.textContent = '(Empty Folder)';
            this.listContainer.appendChild(empty);
            return;
        }

        sorted.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'hfb-item';
            
            const icon = document.createElement('span');
            icon.className = 'hfb-item-icon';
            icon.textContent = entry.isDir ? '📁' : '📄';
            item.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'hfb-item-name';
            name.textContent = entry.name;
            item.appendChild(name);

            if (entry.isDir) {
                item.ondblclick = () => {
                    const nextPath = this.currentPath === '/' ? '/' + entry.name : this.currentPath + '/' + entry.name;
                    this.networkManager.send({
                        command: "LIST_DIR",
                        path: nextPath
                    });
                };
            } else {
                item.onclick = () => {
                    // Highlight selected item
                    this.listContainer?.querySelectorAll('.hfb-item').forEach(el => el.classList.remove('selected'));
                    item.classList.add('selected');
                    this.selectedFilename = entry.name;
                    if (this.fileInput) {
                        this.fileInput.value = entry.name;
                    }
                };

                item.ondblclick = () => {
                    const fullPath = this.currentPath + "/" + entry.name;
                    this.onSelect(fullPath);
                    this.close();
                };
            }

            this.listContainer?.appendChild(item);
        });
    }

    private injectStyles(): void {
        const id = 'hfb-styles';
        if (document.getElementById(id)) return;

        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
            .hfb-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.6);
                backdrop-filter: blur(8px);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: hfb-fade-in 0.2s ease-out;
            }

            .hfb-modal-box {
                width: 600px;
                background: #1e1e24;
                border: 1px solid #3c3c44;
                border-radius: 8px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                display: flex;
                flex-direction: column;
                max-height: 80vh;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                color: #ccc;
                overflow: hidden;
            }

            .hfb-modal-title {
                padding: 12px 16px;
                background: #25252b;
                border-bottom: 1px solid #3c3c44;
                font-size: 13px;
                font-weight: bold;
                color: #00f0ff;
                text-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
            }

            .hfb-toolbar {
                display: flex;
                padding: 8px 12px;
                background: #18181c;
                border-bottom: 1px solid #2d2d34;
                gap: 8px;
                align-items: center;
            }

            .hfb-address-input {
                flex: 1;
                background: #25252b;
                border: 1px solid #3c3c44;
                border-radius: 4px;
                padding: 4px 8px;
                color: #fff;
                font-size: 11px;
                outline: none;
            }
            .hfb-address-input:focus {
                border-color: #00f0ff;
            }

            .hfb-list-container {
                flex: 1;
                height: 300px;
                overflow-y: auto;
                background: #15151a;
                padding: 4px;
            }

            .hfb-item {
                display: flex;
                align-items: center;
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 4px;
                font-size: 12px;
                user-select: none;
            }
            .hfb-item:hover {
                background: rgba(255, 255, 255, 0.05);
            }
            .hfb-item.selected {
                background: rgba(0, 240, 255, 0.15);
                border: 1px solid rgba(0, 240, 255, 0.3);
            }

            .hfb-item-icon {
                margin-right: 8px;
                font-size: 14px;
            }

            .hfb-item-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .hfb-empty {
                padding: 20px;
                text-align: center;
                color: #666;
                font-style: italic;
                font-size: 12px;
            }

            .hfb-footer {
                padding: 12px 16px;
                background: #25252b;
                border-top: 1px solid #3c3c44;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }

            .hfb-label {
                font-size: 11px;
                color: #888;
            }

            .hfb-file-input {
                width: 150px;
                background: #18181c;
                border: 1px solid #3c3c44;
                border-radius: 4px;
                padding: 4px 8px;
                color: #fff;
                font-size: 11px;
                outline: none;
            }
            .hfb-file-input:focus {
                border-color: #00f0ff;
            }

            .hfb-btn {
                background: #2d2d34;
                border: 1px solid #4c4c54;
                color: #ccc;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 4px;
                outline: none;
            }
            .hfb-btn:hover {
                background: #3c3c44;
                color: #fff;
                border-color: #00f0ff;
            }

            .hfb-btn.primary-btn {
                background: #007acc;
                border-color: #0098ff;
                color: #fff;
            }
            .hfb-btn.primary-btn:hover {
                background: #0098ff;
                box-shadow: 0 0 8px rgba(0, 152, 255, 0.4);
            }

            .hfb-btn.secondary-btn {
                background: transparent;
                border-color: #3c3c44;
            }

            .hfb-up-btn {
                padding: 4px 8px;
            }

            @keyframes hfb-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }
}
