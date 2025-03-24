import dotenv from "dotenv";
import express, { Request, Response } from "express";
import cors from "cors";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import MetaApi from "metaapi.cloud-sdk";

const app = express();
const port = 5001;
dotenv.config();

const orderHistory: Record<string, any> = {};

const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  startDefaultMonitoring();
});

const wss = new WebSocket.Server({ server });
const wsConnections: WebSocket[] = [];

wss.on("connection", (ws) => {
  console.log("Client connected");
  wsConnections.push(ws);

  ws.send(
    JSON.stringify({
      event: "initialAccounts",
      accounts: activeConnections.map((conn) => ({
        accountId: conn.accountId,
        accountInfo: conn.connection.terminalState?.accountInformation || {},
        positions: conn.connection.terminalState?.positions || [],
        orders: conn.connection.terminalState?.orders || [],
      })),
    })
  );

  ws.on("close", () => {
    const index = wsConnections.indexOf(ws);
    if (index !== -1) {
      wsConnections.splice(index, 1);
      console.log("Client disconnected");
    }
  });
});

app.use(express.json());
app.use(
  cors({
    origin: process.env.NEXT_FRONTEND_URL,
    credentials: true,
  })
);

const api = new MetaApi(process.env.METATRADER_API_KEY || "");

const activeConnections: {
  accountId: string;
  account: any;
  connection: any;
  listener: any;
  initialState: string;
}[] = [];

class OrderSyncListener {
  accountId: string;
  constructor(accountId: string) {
    this.accountId = accountId;

    if (!orderHistory[this.accountId]) {
      orderHistory[this.accountId] = [];
    }
  }

  onOrderUpdated(orderId: string, order: any) {
    console.log(
      `[Account: ${this.accountId}] Order updated: ${orderId}`,
      order
    );
  }

  onOrderCompleted(orderId: string, order: any) {
    console.log(
      `[Account: ${this.accountId}] Order completed: ${orderId}`,
      order
    );

    // Store completed order in history
    const historyEntry = {
      ...order,
      orderId,
      completedAt: new Date().toISOString(),
    };
    orderHistory[this.accountId].push(historyEntry);

    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "orderCompleted",
          accountId: this.accountId,
          orderId,
          order,
        })
      );
    });
  }

  onPositionUpdated(positionId: string, position: any) {
    console.log(
      `[Account: ${this.accountId}] Position updated: ${positionId}`,
      position
    );

    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "positionUpdated",
          accountId: this.accountId,
          positionId,
          position,
        })
      );
    });
  }

  onDealAdded(dealId: string, deal: any) {
    console.log(`[Account: ${this.accountId}] Deal added: ${dealId}`, deal);

    // If we have deal data, also store it in history with the deal
    const historyEntry = {
      ...deal,
      dealId,
      recordedAt: new Date().toISOString(),
    };

    // Initialize deals history if it doesn't exist
    if (!orderHistory[this.accountId].deals) {
      orderHistory[this.accountId].deals = [];
    }

    orderHistory[this.accountId].deals.push(historyEntry);

    // Notify clients about the new deal
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "dealAdded",
          accountId: this.accountId,
          dealId,
          deal: historyEntry,
        })
      );
    });
  }

  onConnected() {
    console.log(`[Account: ${this.accountId}] Connected to MetaAPI`);
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "accountConnected",
          accountId: this.accountId,
        })
      );
    });
  }

  onDisconnected() {
    console.log(`[Account: ${this.accountId}] Disconnected from MetaAPI`);
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "accountDisconnected",
          accountId: this.accountId,
        })
      );
    });
  }

  onAccountInformationUpdated(accountInformation: any) {
    console.log(
      `[Account: ${this.accountId}] Account information updated:`,
      accountInformation
    );

    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "accountInformationUpdated",
          accountId: this.accountId,
          accountInformation,
        })
      );
    });
  }

  onPositionsUpdated(positions: any) {
    console.log(`[Account: ${this.accountId}] Positions updated:`, positions);
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "positionsUpdated",
          accountId: this.accountId,
          positions,
        })
      );
    });
  }

  onPositionRemoved(positionId: string) {
    console.log(`[Account: ${this.accountId}] Position removed: ${positionId}`);
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "positionRemoved",
          accountId: this.accountId,
          positionId,
        })
      );
    });
  }

  // Add this method to handle symbol price updates
  onSymbolPriceUpdated(symbol: string, price: any) {
    // You can leave this empty if you don't need to process price updates
    // Or you can add processing code here if needed
    // For debugging, you can uncomment the line below
    // console.log(`[Account: ${this.accountId}] Symbol price updated: ${symbol}`, price);
  }

  // Add this method to handle symbol price updates
  onSymbolPricesUpdated(symbolPrices: any) {
    // Implement to handle batch symbol price updates
    // This is different from onSymbolPriceUpdated (singular) which handles individual price updates
    // For debugging, you can uncomment the line below
    // console.log(`[Account: ${this.accountId}] Symbol prices updated for ${Object.keys(symbolPrices).length} symbols`);
  }
}

// Function to connect to an individual account
async function connectToAccount(accountId: string) {
  try {
    console.log(`Connecting to account: ${accountId}`);

    const account = await api.metatraderAccountApi.getAccount(accountId);
    const initialState = account.state;
    const deployedStates = ["DEPLOYING", "DEPLOYED"];

    if (!deployedStates.includes(initialState)) {
      console.log(`Deploying account: ${accountId}`);
      await account.deploy();
    }

    console.log(
      `Waiting for API server to connect to broker for account: ${accountId}`
    );
    await account.waitConnected();

    // Connect to MetaApi API
    let connection = account.getStreamingConnection();
    await connection.connect();

    // Add the synchronization listener to track real-time events
    const listener = new OrderSyncListener(accountId);
    connection.addSynchronizationListener(listener as any);

    // Wait until terminal state synchronized to the local state
    console.log(
      `Waiting for SDK to synchronize terminal state for account: ${accountId}`
    );
    await connection.waitSynchronized();

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
  } catch (err) {
    console.error(`Error connecting to account ${accountId}:`, err);
    return false;
  }
}

// Function to disconnect from an account
async function disconnectFromAccount(accountId: string) {
  const connectionIndex = activeConnections.findIndex(
    (conn) => conn.accountId === accountId
  );

  if (connectionIndex === -1) {
    console.log(`Account ${accountId} not found in active connections`);
    return false;
  }

  const { account, connection, listener, initialState } =
    activeConnections[connectionIndex];

  try {
    // Remove listener before closing
    connection.removeSynchronizationListener(listener);

    // Close the connection
    await connection.close();

    const deployedStates = ["DEPLOYING", "DEPLOYED"];
    if (!deployedStates.includes(initialState)) {
      // Undeploy account if it was undeployed initially
      console.log(`Undeploying account: ${accountId}`);
      await account.undeploy();
    }

    // Remove from active connections
    activeConnections.splice(connectionIndex, 1);

    console.log(`Account ${accountId} disconnected`);

    // Notify all connected clients
    wsConnections.forEach((ws) => {
      ws.send(
        JSON.stringify({
          event: "accountDisconnected",
          accountId,
        })
      );
    });

    return true;
  } catch (err) {
    console.error(`Error disconnecting from account ${accountId}:`, err);
    return false;
  }
}

// Start monitoring with any default account from .env
async function startDefaultMonitoring() {
  // First try to connect to the specified default account if provided
  const defaultAccountId = process.env.ACCOUNT_ID;

  if (defaultAccountId) {
    console.log(
      `Starting monitoring for specified default account: ${defaultAccountId}`
    );
    await connectToAccount(defaultAccountId);
  }

  // Then fetch and connect to all deployed accounts from MetaAPI cloud
  await fetchAndConnectAllAccounts();
}

// Fetch all existing accounts from MetaAPI and connect to them
async function fetchAndConnectAllAccounts() {
  try {
    console.log("Fetching all existing accounts from MetaAPI...");

    // Get all accounts with DEPLOYED state from MetaAPI
    const accounts =
      await api.metatraderAccountApi.getAccountsWithClassicPagination({
        state: ["DEPLOYED"],
      });

    console.log(
      `Found ${accounts.items.length} deployed accounts in MetaAPI cloud`
    );

    // Connect to each account that is not already connected
    let connectedCount = 0;

    for (const account of accounts.items) {
      // Check if we are already connected to this account
      const alreadyConnected = activeConnections.some(
        (conn) => conn.accountId === account.id
      );

      if (!alreadyConnected) {
        console.log(
          `Connecting to existing account: ${account.id} (${
            account.name || "unnamed"
          })`
        );
        const connected = await connectToAccount(account.id);

        if (connected) {
          connectedCount++;
        }
      } else {
        console.log(`Account ${account.id} is already connected, skipping`);
      }
    }

    console.log(
      `Successfully connected to ${connectedCount} additional accounts from MetaAPI cloud`
    );
  } catch (err) {
    console.error("Error fetching accounts from MetaAPI:", err);
  }
}

// API Endpoints

// login endpoint
app.post("/login", (req: Request, res: any) => {
  const { admin_email, admin_password } = req.body;

  if (!admin_email || !admin_password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const { ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET } = process.env;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !JWT_SECRET) {
    return res.status(500).json({ message: "Server configuration error" });
  }

  if (admin_email === ADMIN_EMAIL && admin_password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email: admin_email, role: "admin" }, JWT_SECRET, {
      expiresIn: "3d", // Set JWT expiration to 3 days
    });

    return res.status(200).json({ message: "Authenticated successfully", token });
  }

  return res.status(401).json({ message: "Invalid credentials" });
});


//logout endpoint and to set the jwt age to 0 (the token will be removed from cookie)
app.post("/logout", (req: any, res: any) => {
  res.setHeader(
    "Set-Cookie",
    "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  return res.status(200).json({ message: "Logged out successfully" });
});

// Get all connected accounts
app.get("/accounts", (req: any, res: any) => {
  const accounts = activeConnections.map((conn) => ({
    accountId: conn.accountId,
    name: conn.account.name,
    login: conn.account.login,
    server: conn.account.server,
    platform: conn.account.platform,
    connected: conn.connection.terminalState.connected,
    connectedToBroker: conn.connection.terminalState.connectedToBroker,
    accountInfo: conn.connection.terminalState?.accountInformation || {},
    positions: conn.connection.terminalState?.positions || [],
    orders: conn.connection.terminalState?.orders || [],
  }));

  res.json(accounts);
});

// Get specific account details
app.get("/accounts/:accountId", (req: any, res: any) => {
  const { accountId } = req.params;
  const connection = activeConnections.find(
    (conn) => conn.accountId === accountId
  );

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
    specifications: Object.keys(terminalState.specifications || {}).slice(
      0,
      10
    ), // Just return first 10 for API response
  };

  res.json(accountData);
});

// Get account positions
app.get("/accounts/:accountId/positions", (req: any, res: any) => {
  const { accountId } = req.params;
  const connection = activeConnections.find(
    (conn) => conn.accountId === accountId
  );

  if (!connection) {
    return res.status(404).json({ error: "Account not found" });
  }

  const positions = connection.connection.terminalState.positions;
  res.json(positions);
});

// Get account orders
app.get("/accounts/:accountId/orders", (req: any, res: any) => {
  const { accountId } = req.params;
  const connection = activeConnections.find(
    (conn) => conn.accountId === accountId
  );

  if (!connection) {
    return res.status(404).json({ error: "Account not found" });
  }

  const orders = connection.connection.terminalState.orders;
  res.json(orders);
});

// Get account order history - simplified approach using in-memory storage
app.get("/accounts/:accountId/order-history", (req: any, res: any) => {
  const { accountId } = req.params;
  const connection = activeConnections.find(
    (conn) => conn.accountId === accountId
  );

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
      history = history.filter((order: any) => order.completedAt >= startDate);
    }

    if (endDate) {
      history = history.filter((order: any) => order.completedAt <= endDate);
    }

    if (symbol) {
      history = history.filter((order: any) => order.symbol === symbol);
    }

    if (type) {
      history = history.filter((order: any) => order.type === type);
    }

    // Sort by completion date (newest first)
    history.sort(
      (a: any, b: any) =>
        new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
    );

    res.json(history);
  } catch (error) {
    console.error(`Error fetching history for account ${accountId}:`, error);
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "An unknown error occurred",
    });
  }
});

// Add deal history endpoint using in-memory storage
app.get("/accounts/:accountId/deal-history", (req: any, res: any) => {
  const { accountId } = req.params;
  const connection = activeConnections.find(
    (conn) => conn.accountId === accountId
  );

  if (!connection) {
    return res.status(404).json({ error: "Account not found" });
  }

  try {
    // Get optional query parameters for filtering
    const { startDate, endDate, symbol, type } = req.query;

    // Get deals from our in-memory storage
    let deals = orderHistory[accountId]?.deals || [];

    // Apply filters if provided
    if (startDate) {
      deals = deals.filter((deal: any) => deal.recordedAt >= startDate);
    }

    if (endDate) {
      deals = deals.filter((deal: any) => deal.recordedAt <= endDate);
    }

    if (symbol) {
      deals = deals.filter((deal: any) => deal.symbol === symbol);
    }

    if (type) {
      deals = deals.filter((deal: any) => deal.type === type);
    }

    // Sort by recorded date (newest first)
    deals.sort(
      (a: any, b: any) =>
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
    );

    res.json(deals);
  } catch (error) {
    console.error(
      `Error fetching deal history for account ${accountId}:`,
      error
    );
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "An unknown error occurred",
    });
  }
});

// Add and connect to a new account
app.post("/accounts", async (req: any, res: any) => {
  const { login, server, password, name } = req.body;

  if (!login || !server || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Check if account already exists
    let accountId;
    try {
      // Create account if it doesn't exist

      const newAccount = await api.metatraderAccountApi.createAccount({
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
    } catch (err) {
      console.error("Error creating account:", err);
      return res.status(500).json({ error: (err as any).message });
    }

    // Check if account is already connected
    const alreadyConnected = activeConnections.some(
      (conn) => conn.accountId === accountId
    );

    if (alreadyConnected) {
      return res.status(200).json({
        message: "Account already connected",
        accountId,
      });
    }

    // Connect to the account
    const connected = await connectToAccount(accountId);

    if (connected) {
      res.status(201).json({
        message: "Account added and connected successfully",
        accountId,
      });
    } else {
      res.status(500).json({
        error: "Failed to connect to account",
        accountId,
      });
    }
  } catch (err) {
    console.error("Error adding account:", err);
    res.status(500).json({ error: (err as any).message });
  }
});

// Disconnect from an account
app.delete("/accounts/:accountId", async (req: any, res: any) => {
  const { accountId } = req.params;

  try {
    const disconnected = await disconnectFromAccount(accountId);

    if (disconnected) {
      res.json({ message: `Account ${accountId} disconnected successfully` });
    } else {
      res.status(404).json({
        error: `Account ${accountId} not found or already disconnected`,
      });
    }
  } catch (err) {
    console.error(`Error disconnecting account ${accountId}:`, err);
    res.status(500).json({ error: (err as any).message });
  }
});

// Legacy endpoint for backward compatibility
app.post("/add-account", async (req: any, res: any) => {
  const { login, server, password } = req.body;

  try {
    if (!login || !server || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (activeConnections.some((conn) => conn.account.login === login)) {
      return res.status(400).json({ error: "Account already exists" });
    }
    // Create account if it doesn't exist
    const newAccount = await api.metatraderAccountApi.createAccount({
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
    await connectToAccount(newAccount.id);

    res.status(200).send("Account added");
  } catch (err) {
    console.error("Error in /add-account:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "An unknown error occurred",
    });
  }
});

// Add endpoint to refresh and connect to all MetaAPI accounts
app.post("/refresh-accounts", async (req: any, res: any) => {
  try {
    await fetchAndConnectAllAccounts();
    res.status(200).json({
      message: "Refreshed accounts from MetaAPI",
      connectedAccounts: activeConnections.length,
    });
  } catch (err) {
    console.error("Error refreshing accounts:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "An unknown error occurred",
    });
  }
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");

  // Disconnect from all accounts
  for (const connection of activeConnections) {
    try {
      await disconnectFromAccount(connection.accountId);
    } catch (err) {
      console.error(
        `Error disconnecting from account ${connection.accountId}:`,
        err
      );
    }
  }

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});