
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const HARAKAPAY_BASE_URL = (
  process.env.HARAKAPAY_BASE_URL || "https://harakapay.net"
).replace(/\/$/, "");

const HARAKAPAY_API_KEY = process.env.HARAKAPAY_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// ========================================
// REQUIRED ENVIRONMENT VARIABLES
// ========================================

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure PostgreSQL on Render.");
  process.exit(1);
}

if (!HARAKAPAY_API_KEY) {
  console.error("HARAKAPAY_API_KEY is required. Add it in Render environment variables.");
  process.exit(1);
}

if (!ADMIN_KEY || ADMIN_KEY.length < 24) {
  console.error("ADMIN_KEY is required and must be at least 24 characters.");
  process.exit(1);
}

// ========================================
// POSTGRESQL CONNECTION
// ========================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

// ========================================
// SUPER BUNDLE TZ PACKAGE CATALOGUE
// ========================================

const NETWORKS = ["Vodacom", "Airtel", "Halotel", "Tigo"];

const PACKAGES = [
  {
    id: "6gb",
    name: "6 GB Data Bundle",
    data: "6 GB",
    amount: 3000,
    validity: "1 Month"
  },
  {
    id: "9gb",
    name: "9 GB Data Bundle",
    data: "9 GB",
    amount: 5000,
    validity: "1 Month"
  }
];

// Generate 8 bundles: 2 for each network.
const catalog = NETWORKS.flatMap((network) =>
  PACKAGES.map((bundle) => ({
    id: `${network.toLowerCase()}-${bundle.id}`,
    network,
    name: bundle.name,
    data: bundle.data,
    validity: bundle.validity,
    amount: bundle.amount
  }))
);

console.log(`Loaded ${catalog.length} bundle packages.`);

// ========================================
// DATABASE INITIALIZATION
// ========================================

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      network TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      bundle_name TEXT NOT NULL,
      bundle_data TEXT,
      validity TEXT NOT NULL,
      amount INTEGER NOT NULL,
      payment_order_id TEXT UNIQUE,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      fulfilment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ========================================
// TANZANIA PHONE NUMBER VALIDATION
// ========================================

function normaliseTzPhone(input) {
  let phone = String(input || "").replace(/[\s-]/g, "");

  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  if (/^0[67]\d{8}$/.test(phone)) {
    phone = "255" + phone.slice(1);
  }

  if (!/^255[67]\d{8}$/.test(phone)) {
    return null;
  }

  return phone;
}

// ========================================
// ADMIN AUTHENTICATION
// ========================================

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  return aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const supplied = req.get("x-admin-key") || "";

  if (!safeEqual(supplied, ADMIN_KEY)) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication required."
    });
  }

  next();
}

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "SUPER BUNDLE TZ"
  });
});

// ========================================
// GET ALL AVAILABLE BUNDLES
// ========================================

app.get("/api/bundles", (_req, res) => {
  res.json({
    success: true,
    count: catalog.length,
    bundles: catalog
  });
});

// ========================================
// CREATE CUSTOMER ORDER
// ========================================

app.post("/api/orders", async (req, res) => {
  const phone = normaliseTzPhone(req.body.phone);

  const bundle = catalog.find(
    (b) => b.id === String(req.body.bundleId || "")
  );

  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid Tanzania mobile number, e.g. 0712345678."
    });
  }

  if (!bundle) {
    return res.status(400).json({
      success: false,
      message: "That bundle is unavailable. Refresh and choose an available bundle."
    });
  }

  const id = "SBT-" +
    crypto.randomBytes(5).toString("hex").toUpperCase();

  try {
    const paymentResponse = await fetch(
      `${HARAKAPAY_BASE_URL}/api/v1/collect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": HARAKAPAY_API_KEY
        },
        body: JSON.stringify({
          phone,
          amount: bundle.amount,
          description:
            `SUPER BUNDLE TZ - ${bundle.network} ${bundle.name} - ${id}`
        }),
        signal: AbortSignal.timeout(25000)
      }
    );

    const payment = await paymentResponse.json().catch(() => ({}));

    if (
      !paymentResponse.ok ||
      !payment.success ||
      !payment.order_id
    ) {
      console.error(
        "HarakaPay collection rejected:",
        paymentResponse.status,
        payment.error || "No order ID"
      );

      return res.status(502).json({
        success: false,
        message: payment.error ||
          "Could not start payment. Please try again or contact support."
      });
    }

    await pool.query(
      `INSERT INTO orders
       (id, phone, network, bundle_id, bundle_name, bundle_data,
        validity, amount, payment_order_id, payment_status,
        fulfilment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','awaiting_payment')`,
      [
        id,
        phone,
        bundle.network,
        bundle.id,
        bundle.name,
        bundle.data,
        bundle.validity,
        bundle.amount,
        String(payment.order_id)
      ]
    );

    res.status(201).json({
      success: true,
      orderId: id,
      message: "Payment prompt sent. Approve it on your phone to continue."
    });

  } catch (err) {
    console.error("Order/payment error:", err.message);

    res.status(500).json({
      success: false,
      message: "A server error occurred while starting payment."
    });
  }
});

// ========================================
// CHECK PAYMENT STATUS
// ========================================

app.get("/api/orders/:id/status", async (req, res) => {
  const id = String(req.params.id || "");

  try {
    const found = await pool.query(
      "SELECT * FROM orders WHERE id=$1",
      [id]
    );

    if (!found.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    let order = found.rows[0];

    if (
      order.payment_status !== "completed" &&
      order.payment_status !== "failed"
    ) {
      try {
        const response = await fetch(
          `${HARAKAPAY_BASE_URL}/api/v1/status/${encodeURIComponent(order.payment_order_id)}`,
          {
            headers: {
              "X-API-Key": HARAKAPAY_API_KEY
            },
            signal: AbortSignal.timeout(15000)
          }
        );

        const data = await response.json().catch(() => ({}));

        const status =
          data && data.payment && data.payment.status;

        if (
          response.ok &&
          data.success &&
          ["completed", "failed"].includes(status)
        ) {
          const fulfilment =
            status === "completed"
              ? "awaiting_manual_fulfilment"
              : "awaiting_payment";

          await pool.query(
            `UPDATE orders
             SET payment_status=$1,
                 fulfilment_status=$2,
                 updated_at=NOW()
             WHERE id=$3`,
            [status, fulfilment, id]
          );

          order.payment_status = status;
          order.fulfilment_status = fulfilment;
        }

      } catch (err) {
        console.error("HarakaPay status lookup:", err.message);
      }
    }

    res.json({
      success: true,
      orderId: order.id,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      message:
        order.fulfilment_status === "fulfilled"
          ? "Your bundle has been activated."
          : order.payment_status === "completed"
            ? "Payment received. Your bundle is waiting for manual activation."
            : order.payment_status === "failed"
              ? "Payment failed. You can place a new order."
              : "Waiting for payment confirmation."
    });

  } catch (err) {
    console.error("Status check error:", err.message);

    res.status(500).json({
      success: false,
      message: "Could not check payment status."
    });
  }
});

// ========================================
// PRIVATE ADMIN ENDPOINTS
// ========================================

app.get("/api/admin/orders", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500"
    );

    res.json({
      success: true,
      orders: result.rows
    });

  } catch (err) {
    console.error("Admin orders error:", err.message);

    res.status(500).json({
      success: false,
      message: "Could not retrieve orders."
    });
  }
});

app.post(
  "/api/admin/orders/:id/fulfil",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id || "");
    const note = String(req.body.note || "").slice(0, 500);

    try {
      const result = await pool.query(
        `UPDATE orders
         SET fulfilment_status='fulfilled',
             admin_note=$1,
             updated_at=NOW()
         WHERE id=$2 AND payment_status='completed'
         RETURNING id`,
        [note, id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          success: false,
          message: "Order not found or payment is not confirmed as completed."
        });
      }

      res.json({
        success: true,
        message: "Order marked as manually fulfilled."
      });

    } catch (err) {
      console.error("Admin fulfilment error:", err.message);

      res.status(500).json({
        success: false,
        message: "Could not update order."
      });
    }
  }
);

// ========================================
// SERVE CUSTOMER WEBSITE
// ========================================

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ========================================
// START SERVER
// ========================================

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SUPER BUNDLE TZ running on port ${PORT}`);
      console.log(`Available networks: ${NETWORKS.join(", ")}`);
      console.log(`Available packages: ${catalog.length}`);
    });
  })
  .catch((err) => {
    console.error("Database initialisation failed:", err);
    process.exit(1);
  });
