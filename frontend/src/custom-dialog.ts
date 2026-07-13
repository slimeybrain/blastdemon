export class CustomDialog {
    
    private static injectStyles() {
        const id = 'custom-dialog-styles';
        if (document.getElementById(id)) return;

        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
            .cd-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.65);
                backdrop-filter: blur(8px);
                z-index: 11000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: cd-fade-in 0.15s ease-out;
            }

            .cd-box {
                width: 420px;
                background: #1e1e24;
                border: 1px solid #3c3c44;
                border-radius: 8px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
                display: flex;
                flex-direction: column;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                color: #ccc;
                overflow: hidden;
                animation: cd-slide-down 0.15s ease-out;
            }

            .cd-header {
                padding: 12px 16px;
                background: #25252b;
                border-bottom: 1px solid #3c3c44;
                font-size: 13px;
                font-weight: bold;
                color: #00f0ff;
                text-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
            }

            .cd-body {
                padding: 16px;
                font-size: 12px;
                line-height: 1.5;
                color: #ddd;
            }

            .cd-input-container {
                margin-top: 12px;
            }

            .cd-input {
                width: 100%;
                background: #15151a;
                border: 1px solid #3c3c44;
                border-radius: 4px;
                padding: 6px 10px;
                color: #fff;
                font-size: 12px;
                outline: none;
            }
            .cd-input:focus {
                border-color: #00f0ff;
            }

            .cd-footer {
                padding: 12px 16px;
                background: #25252b;
                border-top: 1px solid #3c3c44;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
            }

            .cd-btn {
                background: #2d2d34;
                border: 1px solid #4c4c54;
                color: #ccc;
                padding: 6px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 500;
                outline: none;
                transition: all 0.1s ease;
            }
            .cd-btn:hover {
                background: #3c3c44;
                color: #fff;
                border-color: #00f0ff;
            }

            .cd-btn.primary {
                background: #007acc;
                border-color: #0098ff;
                color: #fff;
            }
            .cd-btn.primary:hover {
                background: #0098ff;
                box-shadow: 0 0 8px rgba(0, 152, 255, 0.4);
            }

            @keyframes cd-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            @keyframes cd-slide-down {
                from { transform: translateY(-20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    public static alert(message: string, title: string = 'BlastDemon Notification'): Promise<void> {
        this.injectStyles();
        return new Promise<void>((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cd-overlay';

            const box = document.createElement('div');
            box.className = 'cd-box';

            const header = document.createElement('div');
            header.className = 'cd-header';
            header.textContent = title;
            box.appendChild(header);

            const body = document.createElement('div');
            body.className = 'cd-body';
            body.textContent = message;
            box.appendChild(body);

            const footer = document.createElement('div');
            footer.className = 'cd-footer';

            const okBtn = document.createElement('button');
            okBtn.className = 'cd-btn primary';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                overlay.remove();
                resolve();
            };
            footer.appendChild(okBtn);
            box.appendChild(footer);

            overlay.appendChild(box);
            document.body.appendChild(overlay);
            okBtn.focus();
        });
    }

    public static confirm(message: string, title: string = 'BlastDemon Confirm'): Promise<boolean> {
        this.injectStyles();
        return new Promise<boolean>((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cd-overlay';

            const box = document.createElement('div');
            box.className = 'cd-box';

            const header = document.createElement('div');
            header.className = 'cd-header';
            header.textContent = title;
            box.appendChild(header);

            const body = document.createElement('div');
            body.className = 'cd-body';
            body.textContent = message;
            box.appendChild(body);

            const footer = document.createElement('div');
            footer.className = 'cd-footer';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'cd-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = () => {
                overlay.remove();
                resolve(false);
            };
            footer.appendChild(cancelBtn);

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'cd-btn primary';
            confirmBtn.textContent = 'Proceed';
            confirmBtn.onclick = () => {
                overlay.remove();
                resolve(true);
            };
            footer.appendChild(confirmBtn);
            box.appendChild(footer);

            overlay.appendChild(box);
            document.body.appendChild(overlay);
            confirmBtn.focus();
        });
    }

    public static prompt(message: string, defaultValue: string = '', title: string = 'BlastDemon Input'): Promise<string | null> {
        this.injectStyles();
        return new Promise<string | null>((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cd-overlay';

            const box = document.createElement('div');
            box.className = 'cd-box';

            const header = document.createElement('div');
            header.className = 'cd-header';
            header.textContent = title;
            box.appendChild(header);

            const body = document.createElement('div');
            body.className = 'cd-body';
            
            const msgEl = document.createElement('div');
            msgEl.textContent = message;
            body.appendChild(msgEl);

            const inputContainer = document.createElement('div');
            inputContainer.className = 'cd-input-container';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'cd-input';
            input.value = defaultValue;
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    overlay.remove();
                    resolve(input.value);
                } else if (e.key === 'Escape') {
                    overlay.remove();
                    resolve(null);
                }
            };
            inputContainer.appendChild(input);
            body.appendChild(inputContainer);
            box.appendChild(body);

            const footer = document.createElement('div');
            footer.className = 'cd-footer';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'cd-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = () => {
                overlay.remove();
                resolve(null);
            };
            footer.appendChild(cancelBtn);

            const okBtn = document.createElement('button');
            okBtn.className = 'cd-btn primary';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                overlay.remove();
                resolve(input.value);
            };
            footer.appendChild(okBtn);
            box.appendChild(footer);

            overlay.appendChild(box);
            document.body.appendChild(overlay);
            input.focus();
            input.select();
        });
    }
}
