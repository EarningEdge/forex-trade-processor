let MetaApi = require("metaapi.cloud-sdk").default;
const dotenv = require("dotenv");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const app = express();
const port = 5001;
dotenv.config();
const WebSocket = require("ws");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");

// Check for required environment variables
// Create the HTTP server first
const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  startDefaultMonitoring();
});

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ server });
const wsConnections = [];

wss.on("connection", (ws) => {
  console.log("Client connected");
  wsConnections.push(ws);

  // Send current accounts data to new connections
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
    origin: "http://localhost:3000",
    credentials: true, // Allow credentials (cookies , authorization headers, etc.)
  })
);

// Initialize MetaAPI with token

const api = new MetaApi(process.env.METATRADER_API_KEY);

// Track active account connections
const activeConnections = [];

// Create a synchronization listener to track real-time events
class OrderSyncListener {
  constructor(accountId) {
    this.accountId = accountId;
  }

  onOrderUpdated(orderId, order) {
    console.log(
      `[Account: ${this.accountId}] Order updated: ${orderId}`,
      order
    );
  }

  onOrderCompleted(orderId, order) {
    console.log(
      `[Account: ${this.accountId}] Order completed: ${orderId}`,
      order
    );
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

  onPositionUpdated(positionId, position) {
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

  onDealAdded(dealId, deal) {
    console.log(`[Account: ${this.accountId}] Deal added: ${dealId}`, deal);
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

  onAccountInformationUpdated(accountInformation) {
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

  onPositionsUpdated(positions) {
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

  onPositionRemoved(positionId) {
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
}

// Function to connect to an individual account
async function connectToAccount(accountId) {
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
    connection.addSynchronizationListener(listener);

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
async function disconnectFromAccount(accountId) {
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
  const defaultAccountId = process.env.ACCOUNT_ID;

  if (defaultAccountId) {
    console.log(`Starting monitoring for default account: ${defaultAccountId}`);
    await connectToAccount(defaultAccountId);
  } else {
    console.log("No default account ID found in .env");
  }
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
    const token = jwt.sign({ email: admin_email, role: "admin" }, JWT_SECRET, {
      expiresIn: "3d", // Set JWT expiration to 3 days
    });

    // Set HTTP-only cookie
    res.setHeader(
      "Set-Cookie",
      `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=259200`
    );

    return res.status(200).json({ message: "Authenticated successfully" });
  }

  return res.status(401).json({ message: "Invalid credentials" });
});

app.get("/verify", (req, res) => {
  try {
    // Parse cookies from request
    const cookies = cookie.parse(req.headers.cookie || "");
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

    const decoded = jwt.verify(token, JWT_SECRET);

    return res.status(200).json({
      authenticated: true,
      user: {
        email: decoded.email,
        role: decoded.role,
      },
    });
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(401).json({
      authenticated: false,
      message: error instanceof Error ? error.message : "Invalid token",
    });
  }
});

//logout endpoint and to set the jwt age to 0 (the token will be removed from cookie)
app.post("/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  return res.status(200).json({ message: "Logged out successfully" });
});

// Get all connected accounts
app.get("/accounts", (req, res) => {
  const accounts = activeConnections.map((conn) => ({
    accountId: conn.accountId,
    connected: conn.connection.terminalState.connected,
    connectedToBroker: conn.connection.terminalState.connectedToBroker,
    accountInfo: conn.connection.terminalState.accountInformation,
  }));

  res.json(accounts);
});

// Get specific account details
app.get("/accounts/:accountId", (req, res) => {
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
app.get("/accounts/:accountId/positions", (req, res) => {
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
app.get("/accounts/:accountId/orders", (req, res) => {
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

// Add and connect to a new account
app.post("/accounts", async (req, res) => {
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
        type: "cloud",
        platform: "mt5",
        magic: 1000,
        application: "MetaApi",
      });

      accountId = newAccount.id;
      console.log(`Created new account with id ${accountId}`);
    } catch (err) {
      console.error("Error creating account:", err);
      return res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Disconnect from an account
app.delete("/accounts/:accountId", async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// Legacy endpoint for backward compatibility
app.post("/add-account", async (req, res) => {
  const { login, server, password } = req.body;

  try {
    // Create account if it doesn't exist
    const newAccount = await api.metatraderAccountApi.createAccount({
      login,
      server,
      password,
      name: `${login}@${server}`,
      platform: "mt5",
      application: "MetaApi",
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
    res.status(500).json({ error: err.message });
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
