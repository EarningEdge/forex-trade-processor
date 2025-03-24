"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const ws_1 = __importDefault(require("ws"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const cookie_1 = __importDefault(require("cookie"));
const metaapi_cloud_sdk_1 = __importDefault(require("metaapi.cloud-sdk"));
const app = (0, express_1.default)();
const port = 5001;
dotenv_1.default.config();
const orderHistory = {};
const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startDefaultMonitoring();
});
const wss = new ws_1.default.Server({ server });
const wsConnections = [];
wss.on("connection", (ws) => {
    console.log("Client connected");
    wsConnections.push(ws);
    ws.send(JSON.stringify({
        event: "initialAccounts",
        accounts: activeConnections.map((conn) => {
            var _a, _b, _c;
            return ({
                accountId: conn.accountId,
                accountInfo: ((_a = conn.connection.terminalState) === null || _a === void 0 ? void 0 : _a.accountInformation) || {},
                positions: ((_b = conn.connection.terminalState) === null || _b === void 0 ? void 0 : _b.positions) || [],
                orders: ((_c = conn.connection.terminalState) === null || _c === void 0 ? void 0 : _c.orders) || [],
            });
        }),
    }));
    ws.on("close", () => {
        const index = wsConnections.indexOf(ws);
        if (index !== -1) {
            wsConnections.splice(index, 1);
            console.log("Client disconnected");
        }
    });
});
app.use(express_1.default.json());
app.use((0, cors_1.default)({
    origin: process.env.NEXT_FRONTEND_URL,
    credentials: true,
}));
const api = new metaapi_cloud_sdk_1.default(process.env.METATRADER_API_KEY || "");
const activeConnections = [];
class OrderSyncListener {
    constructor(accountId) {
        this.accountId = accountId;
        if (!orderHistory[this.accountId]) {
            orderHistory[this.accountId] = [];
        }
    }
    onOrderUpdated(orderId, order) {
        console.log(`[Account: ${this.accountId}] Order updated: ${orderId}`, order);
    }
    onOrderCompleted(orderId, order) {
        console.log(`[Account: ${this.accountId}] Order completed: ${orderId}`, order);
        // Store completed order in history
        const historyEntry = Object.assign(Object.assign({}, order), { orderId, completedAt: new Date().toISOString() });
        orderHistory[this.accountId].push(historyEntry);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "orderCompleted",
                accountId: this.accountId,
                orderId,
                order,
            }));
        });
    }
    onPositionUpdated(positionId, position) {
        console.log(`[Account: ${this.accountId}] Position updated: ${positionId}`, position);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "positionUpdated",
                accountId: this.accountId,
                positionId,
                position,
            }));
        });
    }
    onDealAdded(dealId, deal) {
        console.log(`[Account: ${this.accountId}] Deal added: ${dealId}`, deal);
        // If we have deal data, also store it in history with the deal
        const historyEntry = Object.assign(Object.assign({}, deal), { dealId, recordedAt: new Date().toISOString() });
        // Initialize deals history if it doesn't exist
        if (!orderHistory[this.accountId].deals) {
            orderHistory[this.accountId].deals = [];
        }
        orderHistory[this.accountId].deals.push(historyEntry);
        // Notify clients about the new deal
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "dealAdded",
                accountId: this.accountId,
                dealId,
                deal: historyEntry,
            }));
        });
    }
    onConnected() {
        console.log(`[Account: ${this.accountId}] Connected to MetaAPI`);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "accountConnected",
                accountId: this.accountId,
            }));
        });
    }
    onDisconnected() {
        console.log(`[Account: ${this.accountId}] Disconnected from MetaAPI`);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "accountDisconnected",
                accountId: this.accountId,
            }));
        });
    }
    onAccountInformationUpdated(accountInformation) {
        console.log(`[Account: ${this.accountId}] Account information updated:`, accountInformation);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "accountInformationUpdated",
                accountId: this.accountId,
                accountInformation,
            }));
        });
    }
    onPositionsUpdated(positions) {
        console.log(`[Account: ${this.accountId}] Positions updated:`, positions);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "positionsUpdated",
                accountId: this.accountId,
                positions,
            }));
        });
    }
    onPositionRemoved(positionId) {
        console.log(`[Account: ${this.accountId}] Position removed: ${positionId}`);
        wsConnections.forEach((ws) => {
            ws.send(JSON.stringify({
                event: "positionRemoved",
                accountId: this.accountId,
                positionId,
            }));
        });
    }
    // Add this method to handle symbol price updates
    onSymbolPriceUpdated(symbol, price) {
        // You can leave this empty if you don't need to process price updates
        // Or you can add processing code here if needed
        // For debugging, you can uncomment the line below
        // console.log(`[Account: ${this.accountId}] Symbol price updated: ${symbol}`, price);
    }
    // Add this method to handle symbol price updates
    onSymbolPricesUpdated(symbolPrices) {
        // Implement to handle batch symbol price updates
        // This is different from onSymbolPriceUpdated (singular) which handles individual price updates
        // For debugging, you can uncomment the line below
        // console.log(`[Account: ${this.accountId}] Symbol prices updated for ${Object.keys(symbolPrices).length} symbols`);
    }
}
// Function to connect to an individual account
function connectToAccount(accountId) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log(`Connecting to account: ${accountId}`);
            const account = yield api.metatraderAccountApi.getAccount(accountId);
            const initialState = account.state;
            const deployedStates = ["DEPLOYING", "DEPLOYED"];
            if (!deployedStates.includes(initialState)) {
                console.log(`Deploying account: ${accountId}`);
                yield account.deploy();
            }
            console.log(`Waiting for API server to connect to broker for account: ${accountId}`);
            yield account.waitConnected();
            // Connect to MetaApi API
            let connection = account.getStreamingConnection();
            yield connection.connect();
            // Add the synchronization listener to track real-time events
            const listener = new OrderSyncListener(accountId);
            connection.addSynchronizationListener(listener);
            // Wait until terminal state synchronized to the local state
            console.log(`Waiting for SDK to synchronize terminal state for account: ${accountId}`);
            yield connection.waitSynchronized();
            // Store connection information
            activeConnections.push({
                accountId,
                account,
                connection,
                listener,
                initialState,
            });
            // Log account is connected and synchronized
            console.log(`Account ${accountId} connected and synchronized`);
            // Send initial account data to all connected clients
            const accountData = {
                event: "accountSynchronized",
                accountId,
                accountInfo: connection.terminalState.accountInformation,
                positions: connection.terminalState.positions,
                orders: connection.terminalState.orders,
            };
            wsConnections.forEach((ws) => {
                ws.send(JSON.stringify(accountData));
            });
            return true;
        }
        catch (err) {
            console.error(`Error connecting to account ${accountId}:`, err);
            return false;
        }
    });
}
// Function to disconnect from an account
function disconnectFromAccount(accountId) {
    return __awaiter(this, void 0, void 0, function* () {
        const connectionIndex = activeConnections.findIndex((conn) => conn.accountId === accountId);
        if (connectionIndex === -1) {
            console.log(`Account ${accountId} not found in active connections`);
            return false;
        }
        const { account, connection, listener, initialState } = activeConnections[connectionIndex];
        try {
            // Remove listener before closing
            connection.removeSynchronizationListener(listener);
            // Close the connection
            yield connection.close();
            const deployedStates = ["DEPLOYING", "DEPLOYED"];
            if (!deployedStates.includes(initialState)) {
                // Undeploy account if it was undeployed initially
                console.log(`Undeploying account: ${accountId}`);
                yield account.undeploy();
            }
            // Remove from active connections
            activeConnections.splice(connectionIndex, 1);
            console.log(`Account ${accountId} disconnected`);
            // Notify all connected clients
            wsConnections.forEach((ws) => {
                ws.send(JSON.stringify({
                    event: "accountDisconnected",
                    accountId,
                }));
            });
            return true;
        }
        catch (err) {
            console.error(`Error disconnecting from account ${accountId}:`, err);
            return false;
        }
    });
}
// Start monitoring with any default account from .env
function startDefaultMonitoring() {
    return __awaiter(this, void 0, void 0, function* () {
        // First try to connect to the specified default account if provided
        const defaultAccountId = process.env.ACCOUNT_ID;
        if (defaultAccountId) {
            console.log(`Starting monitoring for specified default account: ${defaultAccountId}`);
            yield connectToAccount(defaultAccountId);
        }
        // Then fetch and connect to all deployed accounts from MetaAPI cloud
        yield fetchAndConnectAllAccounts();
    });
}
// Fetch all existing accounts from MetaAPI and connect to them
function fetchAndConnectAllAccounts() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log("Fetching all existing accounts from MetaAPI...");
            // Get all accounts with DEPLOYED state from MetaAPI
            const accounts = yield api.metatraderAccountApi.getAccountsWithClassicPagination({
                state: ["DEPLOYED"],
            });
            console.log(`Found ${accounts.items.length} deployed accounts in MetaAPI cloud`);
            // Connect to each account that is not already connected
            let connectedCount = 0;
            for (const account of accounts.items) {
                // Check if we are already connected to this account
                const alreadyConnected = activeConnections.some((conn) => conn.accountId === account.id);
                if (!alreadyConnected) {
                    console.log(`Connecting to existing account: ${account.id} (${account.name || "unnamed"})`);
                    const connected = yield connectToAccount(account.id);
                    if (connected) {
                        connectedCount++;
                    }
                }
                else {
                    console.log(`Account ${account.id} is already connected, skipping`);
                }
            }
            console.log(`Successfully connected to ${connectedCount} additional accounts from MetaAPI cloud`);
        }
        catch (err) {
            console.error("Error fetching accounts from MetaAPI:", err);
        }
    });
}
// API Endpoints
// login endpoint
app.post("/login", (req, res) => {
    const { admin_email, admin_password } = req.body;
    if (!admin_email || !admin_password) {
        return res.status(400).json({ message: "Email and password are required" });
    }
    const { ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !JWT_SECRET) {
        return res.status(500).json({ message: "Server configuration error" });
    }
    if (admin_email === ADMIN_EMAIL && admin_password === ADMIN_PASSWORD) {
        const token = jsonwebtoken_1.default.sign({ email: admin_email, role: "admin" }, JWT_SECRET, {
            expiresIn: "3d", // Set JWT expiration to 3 days
        });
        // Set HTTP-only cookie
        res.setHeader("Set-Cookie", `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=259200`);
        return res.status(200).json({ message: "Authenticated successfully" });
    }
    return res.status(401).json({ message: "Invalid credentials" });
});
app.get("/verify", (req, res) => {
    try {
        // Parse cookies from request
        const cookies = cookie_1.default.parse(req.headers.cookie || "");
        const token = cookies.token;
        if (!token) {
            return res.status(401).json({
                authenticated: false,
                message: "No authentication token found",
            });
        }
        // Verify JWT
        const { JWT_SECRET } = process.env;
        if (!JWT_SECRET) {
            throw new Error("JWT secret not configured");
        }
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        return res.status(200).json({
            authenticated: true,
            user: {
                email: decoded.email,
                role: decoded.role,
            },
        });
    }
    catch (error) {
        console.error("Verification error:", error);
        return res.status(401).json({
            authenticated: false,
            message: error instanceof Error ? error.message : "Invalid token",
        });
    }
});
//logout endpoint and to set the jwt age to 0 (the token will be removed from cookie)
app.post("/logout", (req, res) => {
    res.setHeader("Set-Cookie", "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return res.status(200).json({ message: "Logged out successfully" });
});
// Get all connected accounts
app.get("/accounts", (req, res) => {
    const accounts = activeConnections.map((conn) => {
        var _a, _b, _c;
        return ({
            accountId: conn.accountId,
            name: conn.account.name,
            login: conn.account.login,
            server: conn.account.server,
            platform: conn.account.platform,
            connected: conn.connection.terminalState.connected,
            connectedToBroker: conn.connection.terminalState.connectedToBroker,
            accountInfo: ((_a = conn.connection.terminalState) === null || _a === void 0 ? void 0 : _a.accountInformation) || {},
            positions: ((_b = conn.connection.terminalState) === null || _b === void 0 ? void 0 : _b.positions) || [],
            orders: ((_c = conn.connection.terminalState) === null || _c === void 0 ? void 0 : _c.orders) || [],
        });
    });
    res.json(accounts);
});
// Get specific account details
app.get("/accounts/:accountId", (req, res) => {
    const { accountId } = req.params;
    const connection = activeConnections.find((conn) => conn.accountId === accountId);
    if (!connection) {
        return res.status(404).json({ error: "Account not found" });
    }
    const terminalState = connection.connection.terminalState;
    const accountData = {
        accountId,
        connected: terminalState.connected,
        connectedToBroker: terminalState.connectedToBroker,
        accountInfo: terminalState.accountInformation,
        positions: terminalState.positions,
        orders: terminalState.orders,
        specifications: Object.keys(terminalState.specifications || {}).slice(0, 10), // Just return first 10 for API response
    };
    res.json(accountData);
});
// Get account positions
app.get("/accounts/:accountId/positions", (req, res) => {
    const { accountId } = req.params;
    const connection = activeConnections.find((conn) => conn.accountId === accountId);
    if (!connection) {
        return res.status(404).json({ error: "Account not found" });
    }
    const positions = connection.connection.terminalState.positions;
    res.json(positions);
});
// Get account orders
app.get("/accounts/:accountId/orders", (req, res) => {
    const { accountId } = req.params;
    const connection = activeConnections.find((conn) => conn.accountId === accountId);
    if (!connection) {
        return res.status(404).json({ error: "Account not found" });
    }
    const orders = connection.connection.terminalState.orders;
    res.json(orders);
});
// Get account order history - simplified approach using in-memory storage
app.get("/accounts/:accountId/order-history", (req, res) => {
    const { accountId } = req.params;
    const connection = activeConnections.find((conn) => conn.accountId === accountId);
    if (!connection) {
        return res.status(404).json({ error: "Account not found" });
    }
    try {
        // Get optional query parameters for filtering
        const { startDate, endDate, symbol, type } = req.query;
        // Get history from our in-memory storage
        let history = orderHistory[accountId] || [];
        // Apply filters if provided
        if (startDate) {
            history = history.filter((order) => order.completedAt >= startDate);
        }
        if (endDate) {
            history = history.filter((order) => order.completedAt <= endDate);
        }
        if (symbol) {
            history = history.filter((order) => order.symbol === symbol);
        }
        if (type) {
            history = history.filter((order) => order.type === type);
        }
        // Sort by completion date (newest first)
        history.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
        res.json(history);
    }
    catch (error) {
        console.error(`Error fetching history for account ${accountId}:`, error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "An unknown error occurred",
        });
    }
});
// Add deal history endpoint using in-memory storage
app.get("/accounts/:accountId/deal-history", (req, res) => {
    var _a;
    const { accountId } = req.params;
    const connection = activeConnections.find((conn) => conn.accountId === accountId);
    if (!connection) {
        return res.status(404).json({ error: "Account not found" });
    }
    try {
        // Get optional query parameters for filtering
        const { startDate, endDate, symbol, type } = req.query;
        // Get deals from our in-memory storage
        let deals = ((_a = orderHistory[accountId]) === null || _a === void 0 ? void 0 : _a.deals) || [];
        // Apply filters if provided
        if (startDate) {
            deals = deals.filter((deal) => deal.recordedAt >= startDate);
        }
        if (endDate) {
            deals = deals.filter((deal) => deal.recordedAt <= endDate);
        }
        if (symbol) {
            deals = deals.filter((deal) => deal.symbol === symbol);
        }
        if (type) {
            deals = deals.filter((deal) => deal.type === type);
        }
        // Sort by recorded date (newest first)
        deals.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
        res.json(deals);
    }
    catch (error) {
        console.error(`Error fetching deal history for account ${accountId}:`, error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "An unknown error occurred",
        });
    }
});
// Add and connect to a new account
app.post("/accounts", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { login, server, password, name } = req.body;
    if (!login || !server || !password) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    try {
        // Check if account already exists
        let accountId;
        try {
            // Create account if it doesn't exist
            const newAccount = yield api.metatraderAccountApi.createAccount({
                login,
                server,
                password,
                name: name || `${login}@${server}`,
                //@ts-ignore
                type: "cloud",
                platform: "mt5",
                magic: 1000,
                application: "MetaApi",
            });
            accountId = newAccount.id;
            console.log(`Created new account with id ${accountId}`);
        }
        catch (err) {
            console.error("Error creating account:", err);
            return res.status(500).json({ error: err.message });
        }
        // Check if account is already connected
        const alreadyConnected = activeConnections.some((conn) => conn.accountId === accountId);
        if (alreadyConnected) {
            return res.status(200).json({
                message: "Account already connected",
                accountId,
            });
        }
        // Connect to the account
        const connected = yield connectToAccount(accountId);
        if (connected) {
            res.status(201).json({
                message: "Account added and connected successfully",
                accountId,
            });
        }
        else {
            res.status(500).json({
                error: "Failed to connect to account",
                accountId,
            });
        }
    }
    catch (err) {
        console.error("Error adding account:", err);
        res.status(500).json({ error: err.message });
    }
}));
// Disconnect from an account
app.delete("/accounts/:accountId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { accountId } = req.params;
    try {
        const disconnected = yield disconnectFromAccount(accountId);
        if (disconnected) {
            res.json({ message: `Account ${accountId} disconnected successfully` });
        }
        else {
            res.status(404).json({
                error: `Account ${accountId} not found or already disconnected`,
            });
        }
    }
    catch (err) {
        console.error(`Error disconnecting account ${accountId}:`, err);
        res.status(500).json({ error: err.message });
    }
}));
// Legacy endpoint for backward compatibility
app.post("/add-account", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { login, server, password } = req.body;
    try {
        if (!login || !server || !password) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (activeConnections.some((conn) => conn.account.login === login)) {
            return res.status(400).json({ error: "Account already exists" });
        }
        // Create account if it doesn't exist
        const newAccount = yield api.metatraderAccountApi.createAccount({
            login,
            server,
            password,
            name: `${login}@${server}`,
            platform: "mt5",
            application: "MetaApi",
            //@ts-ignore
            type: "cloud",
            magic: 1000,
        });
        console.log("Account created");
        console.log(newAccount);
        // Connect to the account
        yield connectToAccount(newAccount.id);
        res.status(200).send("Account added");
    }
    catch (err) {
        console.error("Error in /add-account:", err);
        res.status(500).json({
            error: err instanceof Error ? err.message : "An unknown error occurred",
        });
    }
}));
// Add endpoint to refresh and connect to all MetaAPI accounts
app.post("/refresh-accounts", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield fetchAndConnectAllAccounts();
        res.status(200).json({
            message: "Refreshed accounts from MetaAPI",
            connectedAccounts: activeConnections.length,
        });
    }
    catch (err) {
        console.error("Error refreshing accounts:", err);
        res.status(500).json({
            error: err instanceof Error ? err.message : "An unknown error occurred",
        });
    }
}));
// Handle graceful shutdown
process.on("SIGINT", () => __awaiter(void 0, void 0, void 0, function* () {
    console.log("Shutting down server...");
    // Disconnect from all accounts
    for (const connection of activeConnections) {
        try {
            yield disconnectFromAccount(connection.accountId);
        }
        catch (err) {
            console.error(`Error disconnecting from account ${connection.accountId}:`, err);
        }
    }
    server.close(() => {
        console.log("Server closed");
        process.exit(0);
    });
}));
