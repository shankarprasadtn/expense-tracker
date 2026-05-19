// app.js
document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    let expenses = JSON.parse(localStorage.getItem('expenses')) || [];
    let googleClientId = localStorage.getItem('googleClientId') || '';
    let googleSheetId = localStorage.getItem('googleSheetId') || '';
    let googleAccessToken = null;
    let tokenClient = null;
    let chartInstance = null;

    // Initialize Token Client
    function initGoogleTokenClient() {
        if (!googleClientId || !window.google) return;
        
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: googleClientId,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            callback: (tokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    googleAccessToken = tokenResponse.access_token;
                    // Update UI if on settings view
                    const authStatus = document.getElementById('google-auth-status');
                    if (authStatus) {
                        document.getElementById('btn-google-login').style.display = 'none';
                        document.getElementById('btn-google-logout').style.display = 'inline-flex';
                        authStatus.textContent = 'Signed in successfully';
                        authStatus.style.color = '#10B981';
                    }
                }
            },
        });
    }

    // Attempt init shortly after boot (allows async script to load)
    setTimeout(() => {
        if(window.google) initGoogleTokenClient();
    }, 1500);

    // --- DOM Elements ---
    const mainContent = document.getElementById('main-content');
    const navItems = document.querySelectorAll('.nav-item');

    // --- Navigation Logic ---
    function renderView(viewId) {
        const template = document.getElementById(`view-${viewId}`);
        if (!template) return;

        // Clear and append new view
        mainContent.innerHTML = '';
        mainContent.appendChild(template.content.cloneNode(true));

        // Update nav active state
        navItems.forEach(item => {
            if (item.dataset.view === viewId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Initialize view specific logic
        if (viewId === 'dashboard') initDashboard();
        if (viewId === 'add') initAddExpense();
        if (viewId === 'history') initHistory();
        if (viewId === 'settings') initSettings();
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            renderView(item.dataset.view);
        });
    });

    // --- View Initializers ---

    function initDashboard() {
        updateTotalSpent();
        renderTransactions();
        renderCategoryBreakdown();
    }

    function initAddExpense() {
        const amountInput = document.getElementById('amount');
        const notesInput = document.getElementById('add-notes');
        const btnSave = document.getElementById('btn-save-expense');
        const btnPaste = document.getElementById('btn-paste-clipboard');
        const catBtns = document.querySelectorAll('.cat-btn');
        const segBtns = document.querySelectorAll('.seg-btn');

        let selectedCategory = { name: "Food", icon: "🍔" };
        let selectedPaymentMethod = "UPI"; // Default

        // Payment Method Selection
        segBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                segBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedPaymentMethod = btn.dataset.method;
            });
        });

        // Clipboard Logic
        if (btnPaste) {
            btnPaste.addEventListener('click', async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    if (!text) return;
                    
                    // Extract number from clipboard (handles commas or pure numbers)
                    const match = text.match(/[\d,]+(?:\.\d+)?/);
                    if (match) {
                        const parsedRaw = match[0].replace(/,/g, ''); // Remove commas
                        amountInput.value = parsedRaw;
                        
                        // Default to Other for SMS
                        const otherBtn = Array.from(catBtns).find(b => b.dataset.cat === 'Other');
                        if(otherBtn) otherBtn.click();
                        
                        notesInput.value = "Bank SMS";
                    } else {
                        alert("No amount found in clipboard.");
                    }
                } catch (err) {
                    alert("Could not read clipboard. Please ensure you allow paste permissions.");
                }
            });
        }

        // Category Selection
        catBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                catBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedCategory = {
                    name: btn.dataset.cat,
                    icon: btn.dataset.icon
                };
            });
        });

        // Save Logic
        btnSave.addEventListener('click', () => {
            // Strip out commas, spaces, or any other weird characters from the input
            const rawVal = amountInput.value.replace(/[^0-9.]/g, '');
            const amount = parseFloat(rawVal);
            
            if (isNaN(amount) || amount <= 0) {
                alert("Please enter a valid amount.");
                return;
            }

            const expense = {
                id: Date.now().toString(),
                amount: amount,
                category: selectedCategory.name,
                icon: selectedCategory.icon,
                date: new Date().toISOString().split('T')[0],
                notes: notesInput.value.trim(),
                paymentMethod: selectedPaymentMethod,
                timestamp: new Date().toISOString()
            };

            expenses.push(expense);
            saveData();
            
            // Sync to Google Sheets directly if configured and signed in
            if (googleAccessToken && googleSheetId) {
                const valueRangeBody = {
                    "majorDimension": "ROWS",
                    "values": [
                        [expense.date, expense.amount, expense.category, expense.notes, expense.paymentMethod]
                    ]
                };

                fetch(`https://sheets.googleapis.com/v4/spreadsheets/${googleSheetId}/values/A:E:append?valueInputOption=USER_ENTERED`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${googleAccessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(valueRangeBody)
                })
                .then(async res => {
                    if(!res.ok) {
                        const errText = await res.text();
                        console.error("Google Sheets Sync Failed", errText);
                        alert(`Google API Error (${res.status}): ` + errText);
                        if(res.status === 401) {
                            googleAccessToken = null; // Token expired
                        }
                    }
                })
                .catch(err => {
                    console.error("Network error syncing to Sheets", err);
                    alert("Network error: Could not reach Google Servers.");
                });
            }
            
            // Reset and Navigate back
            amountInput.value = "";
            notesInput.value = "";
            renderView('dashboard');
        });
    }

    function initHistory() {
        const listEl = document.getElementById('history-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        if (expenses.length === 0) {
            listEl.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding: 20px;">No history available.</p>';
            return;
        }

        // Group expenses
        const grouped = {};
        expenses.forEach(exp => {
            const dateObj = new Date(exp.date);
            const monthYear = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            const day = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            
            if(!grouped[monthYear]) grouped[monthYear] = {};
            if(!grouped[monthYear][day]) grouped[monthYear][day] = [];
            grouped[monthYear][day].push(exp);
        });

        // Render groups
        for (const [month, days] of Object.entries(grouped)) {
            const monthDiv = document.createElement('div');
            monthDiv.innerHTML = `<div class="history-month-header">${month}</div>`;
            
            for (const [day, dayExpenses] of Object.entries(days)) {
                const dayDiv = document.createElement('div');
                dayDiv.innerHTML = `<div class="history-date-header">${day}</div>`;
                
                const ul = document.createElement('ul');
                ul.className = 'transaction-list';
                ul.style.marginTop = '0';
                
                dayExpenses.forEach(exp => {
                    const li = document.createElement('li');
                    li.className = 'transaction-item';
                    li.innerHTML = `
                        <div class="t-info">
                            <div class="t-icon">${exp.icon}</div>
                            <div class="t-details">
                                <h4>${exp.category}</h4>
                                <p>${exp.paymentMethod || 'UPI'} ${exp.notes ? '• ' + exp.notes : ''}</p>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div class="t-amount">-₹${exp.amount.toFixed(2)}</div>
                            <button class="btn-delete-history" data-id="${exp.id}" style="background:transparent; color:var(--danger); padding:4px; font-size:18px;">
                                <ion-icon name="trash-outline"></ion-icon>
                            </button>
                        </div>
                    `;
                    ul.appendChild(li);
                });
                
                dayDiv.appendChild(ul);
                monthDiv.appendChild(dayDiv);
            }
            listEl.appendChild(monthDiv);
        }

        // Attach delete event listeners for history view
        document.querySelectorAll('.btn-delete-history').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                if(confirm("Delete this expense?")) {
                    expenses = expenses.filter(exp => exp.id !== id);
                    saveData();
                    initHistory(); // Refresh history list
                }
            });
        });

        // Quick Export button logic
        const btnQuickExport = document.getElementById('btn-quick-export');
        if (btnQuickExport) {
            btnQuickExport.addEventListener('click', exportToExcel);
        }
    }

    function initSettings() {
        const btnClear = document.getElementById('btn-clear-data');
        const inputClientId = document.getElementById('google-client-id');
        const inputSheetId = document.getElementById('google-sheet-id');
        const btnSaveGoogle = document.getElementById('btn-save-google');
        const btnGoogleLogin = document.getElementById('btn-google-login');
        const btnGoogleLogout = document.getElementById('btn-google-logout');
        const authContainer = document.getElementById('google-auth-container');
        const authStatus = document.getElementById('google-auth-status');
        
        const btnExport = document.getElementById('btn-export-excel');
        const btnImport = document.getElementById('btn-import-data');
        const fileImport = document.getElementById('file-import');

        if (inputClientId) inputClientId.value = googleClientId;
        if (inputSheetId) inputSheetId.value = googleSheetId;

        function updateGoogleUI() {
            if (googleClientId && googleSheetId) {
                authContainer.style.display = 'block';
                if (googleAccessToken) {
                    btnGoogleLogin.style.display = 'none';
                    btnGoogleLogout.style.display = 'inline-flex';
                    authStatus.textContent = 'Signed in successfully';
                    authStatus.style.color = '#10B981';
                } else {
                    btnGoogleLogin.style.display = 'inline-flex';
                    btnGoogleLogout.style.display = 'none';
                    authStatus.textContent = 'Not signed in';
                    authStatus.style.color = 'var(--text-muted)';
                }
            } else {
                authContainer.style.display = 'none';
            }
        }
        updateGoogleUI();

        btnExport.addEventListener('click', exportToExcel);

        if (btnImport && fileImport) {
            btnImport.addEventListener('click', () => {
                fileImport.click();
            });

            fileImport.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (evt) => {
                    try {
                        const data = new Uint8Array(evt.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });
                        const firstSheetName = workbook.SheetNames[0];
                        const worksheet = workbook.Sheets[firstSheetName];
                        const json = XLSX.utils.sheet_to_json(worksheet);

                        if (!json || json.length === 0) {
                            alert("The file appears to be empty.");
                            return;
                        }

                        let importedCount = 0;
                        json.forEach(row => {
                            const amount = parseFloat(row.Amount);
                            if (isNaN(amount)) return; // Skip invalid rows

                            const date = row.Date || new Date().toISOString().split('T')[0];
                            const category = row.Category || "Other";
                            const notes = row.Notes || "";
                            const timestamp = row.Timestamp || new Date().toISOString();
                            const id = row.Timestamp ? row.Timestamp.replace(/\D/g, '') : Date.now().toString() + Math.floor(Math.random()*1000);

                            // Try to infer icon
                            let icon = "✨";
                            if (category === "Food") icon = "🍔";
                            else if (category === "Transport") icon = "🚗";
                            else if (category === "Shopping") icon = "🛍️";
                            else if (category === "Bills") icon = "🧾";
                            else if (category === "Entertainment") icon = "🎬";
                            else if (category === "Groceries") icon = "🛒";
                            else if (category === "Health") icon = "💊";
                            else if (category === "Travel") icon = "✈️";
                            else if (category === "Education") icon = "📚";
                            else if (category === "Personal") icon = "💅";

                            // Avoid duplicates by checking timestamp or exact same amount/date combo
                            const exists = expenses.some(e => e.timestamp === timestamp || (e.amount === amount && e.date === date && e.category === category && e.notes === notes));
                            
                            if (!exists) {
                                expenses.push({
                                    id: id,
                                    amount: amount,
                                    category: category,
                                    icon: icon,
                                    date: date,
                                    notes: notes,
                                    paymentMethod: row['Payment Method'] || 'UPI',
                                    timestamp: timestamp
                                });
                                importedCount++;
                            }
                        });

                        saveData();
                        alert(`Successfully imported ${importedCount} new expenses!`);
                        renderView('dashboard');
                    } catch (error) {
                        console.error(error);
                        alert("Failed to parse the file. Please ensure it is a valid Excel or CSV file generated by this app.");
                    }
                    fileImport.value = ''; // Reset
                };
                reader.readAsArrayBuffer(file);
            });
        }

        if (btnSaveGoogle) {
            btnSaveGoogle.addEventListener('click', () => {
                googleClientId = inputClientId.value.trim();
                googleSheetId = inputSheetId.value.trim();
                localStorage.setItem('googleClientId', googleClientId);
                localStorage.setItem('googleSheetId', googleSheetId);
                alert("Google Credentials Saved!");
                
                initGoogleTokenClient();
                updateGoogleUI();
            });
        }

        if (btnGoogleLogin) {
            btnGoogleLogin.addEventListener('click', () => {
                if (!tokenClient) initGoogleTokenClient();
                if (tokenClient) {
                    tokenClient.requestAccessToken({prompt: 'consent'});
                } else {
                    alert("Google scripts not loaded or Client ID missing.");
                }
            });
        }

        if (btnGoogleLogout) {
            btnGoogleLogout.addEventListener('click', () => {
                if (googleAccessToken) {
                    google.accounts.oauth2.revoke(googleAccessToken, () => {
                        googleAccessToken = null;
                        updateGoogleUI();
                    });
                }
            });
        }
        
        btnClear.addEventListener('click', () => {
            if(confirm("Are you sure? This will delete all your expense data permanently.")) {
                expenses = [];
                saveData();
                alert("Data cleared.");
                renderView('dashboard');
            }
        });
    }

    // --- Logic & Helpers ---

    function saveData() {
        // Sort by date descending
        expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
        localStorage.setItem('expenses', JSON.stringify(expenses));
    }

    function updateTotalSpent() {
        const totalEl = document.getElementById('total-spent');
        if (!totalEl) return;

        // Get current month and year
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const monthlyTotal = expenses
            .filter(exp => {
                const expDate = new Date(exp.date);
                return expDate.getMonth() === currentMonth && expDate.getFullYear() === currentYear;
            })
            .reduce((sum, exp) => sum + exp.amount, 0);

        totalEl.textContent = `₹${monthlyTotal.toFixed(2)}`;
    }

    function renderTransactions() {
        const listEl = document.getElementById('transaction-list');
        if (!listEl) return;

        listEl.innerHTML = '';
        
        if (expenses.length === 0) {
            listEl.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding: 20px;">No expenses yet.</p>';
            return;
        }

        // Show only latest 10
        const recentExpenses = expenses.slice(0, 10);

        recentExpenses.forEach(exp => {
            const li = document.createElement('li');
            li.className = 'transaction-item';
            
            // Format date: "Oct 12"
            const dateObj = new Date(exp.date);
            const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

            li.innerHTML = `
                <div class="t-info">
                    <div class="t-icon">${exp.icon}</div>
                    <div class="t-details">
                        <h4>${exp.category}</h4>
                        <p>${dateStr} • ${exp.paymentMethod || 'UPI'} ${exp.notes ? '• ' + exp.notes : ''}</p>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div class="t-amount">-₹${exp.amount.toFixed(2)}</div>
                    <button class="btn-delete" data-id="${exp.id}" style="background:transparent; color:var(--danger); padding:4px; font-size:18px;">
                        <ion-icon name="trash-outline"></ion-icon>
                    </button>
                </div>
            `;
            listEl.appendChild(li);
        });

        // Attach delete event listeners
        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                if(confirm("Delete this expense?")) {
                    expenses = expenses.filter(exp => exp.id !== id);
                    saveData();
                    initDashboard(); // Refresh chart and list
                }
            });
        });
    }

    function renderCategoryBreakdown() {
        const container = document.getElementById('category-breakdown-list');
        if (!container) return;

        container.innerHTML = '';

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        let totalForMonth = 0;
        const categoryData = {}; 

        expenses.forEach(exp => {
            const expDate = new Date(exp.date);
            if (expDate.getMonth() === currentMonth && expDate.getFullYear() === currentYear) {
                if (!categoryData[exp.category]) {
                    categoryData[exp.category] = { amount: 0, icon: exp.icon };
                }
                categoryData[exp.category].amount += exp.amount;
                totalForMonth += exp.amount;
            }
        });

        if (totalForMonth === 0) {
            container.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding: 20px;">No data for this month</p>';
            return;
        }

        const colors = {
            'Food': '#FF9500',
            'Transport': '#34C759',
            'Shopping': '#AF52DE',
            'Bills': '#FF3B30',
            'Entertainment': '#5AC8FA',
            'Groceries': '#007AFF',
            'Health': '#FF2D55',
            'Travel': '#5856D6',
            'Education': '#FFCC00',
            'Personal': '#FF453A',
            'Other': '#8E8E93'
        };

        const sortedCats = Object.keys(categoryData).sort((a, b) => categoryData[b].amount - categoryData[a].amount);

        sortedCats.forEach((cat, index) => {
            const data = categoryData[cat];
            const percentage = (data.amount / totalForMonth) * 100;
            const color = colors[cat] || '#8E8E93';

            const item = document.createElement('div');
            item.className = 'cat-stat-item';
            
            // Staggered slide up animation
            item.style.animation = `slideUp 0.4s cubic-bezier(0.25, 1, 0.5, 1) forwards ${index * 0.1}s`;
            item.style.opacity = '0';

            item.innerHTML = `
                <div class="cat-stat-icon" style="color: ${color}; background: ${color}15;">${data.icon}</div>
                <div class="cat-stat-details">
                    <div class="cat-stat-header">
                        <span class="cat-stat-name">${cat}</span>
                        <span class="cat-stat-amount">₹${data.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                    </div>
                    <div class="cat-stat-bar-bg">
                        <div class="cat-stat-bar-fill" style="width: 0%; background: ${color};" data-target-width="${percentage}%"></div>
                    </div>
                </div>
            `;
            container.appendChild(item);
        });

        // Trigger fill animation after tiny delay
        setTimeout(() => {
            document.querySelectorAll('.cat-stat-bar-fill').forEach(bar => {
                bar.style.width = bar.dataset.targetWidth;
            });
        }, 50);
    }

    function exportToExcel() {
        if (expenses.length === 0) {
            alert("No data to export.");
            return;
        }

        const data = expenses.map(e => ({
            Date: e.date,
            Category: e.category,
            'Payment Method': e.paymentMethod || 'UPI',
            Amount: e.amount,
            Notes: e.notes || "",
            Timestamp: e.timestamp
        }));

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Expenses");

        const fileName = `ExpenseData_${new Date().toISOString().split('T')[0]}.xlsx`;

        // Attempt iOS Share Sheet if possible
        if (navigator.canShare && window.File) {
            try {
                const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
                const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8' });
                const file = new File([blob], fileName, { type: blob.type });

                if (navigator.canShare({ files: [file] })) {
                    navigator.share({
                        files: [file],
                        title: 'Expense Tracker Data',
                        text: 'Here is my expense tracking data.'
                    }).catch(console.error);
                    return; // Successfully opened share sheet
                }
            } catch (err) {
                console.log("Share failed, falling back to download", err);
            }
        }

        // Fallback standard download
        XLSX.writeFile(workbook, fileName);
    }

    // --- Boot ---
    // Start by rendering Dashboard
    renderView('dashboard');
});
