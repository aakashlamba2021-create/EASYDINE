require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

app.use(express.json()); 
app.use(express.static(__dirname)); 

const port = 3000;

const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,       // Tells Node to use the Aiven port
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false    // Tells Aiven to accept this encrypted connection
    }
});

connection.connect((err) => {
    if (err) console.error('Error connecting to MySQL database:', err);
    else console.log('Connected to MySQL database');
});

// --- PAGE ROUTES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

// --- CUSTOMER AUTHENTICATION ROUTES ---
app.post('/customer/signup', (req, res) => {
    const { username, mobile, password } = req.body;
    const query = 'INSERT INTO Customers (username, mobile, password) VALUES (?, ?, ?)';
    connection.query(query, [username, mobile, password], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: "Mobile number already registered!" });
            return res.status(500).json({ error: "Database error during signup." });
        }
        res.json({ success: true, customer_id: result.insertId, username: username });
    });
});

app.post('/customer/login', (req, res) => {
    const { mobile, password } = req.body;
    const query = 'SELECT * FROM Customers WHERE mobile = ? AND password = ?';
    connection.query(query, [mobile, password], (err, results) => {
        if (err) return res.status(500).json({ error: "Database error." });
        if (results.length > 0) res.json({ success: true, customer: results[0] });
        else res.status(401).json({ error: "Invalid Mobile or Password!" });
    });
});

// Fetches detailed orders AND the specific items inside them
app.get('/customer/orders/:id', (req, res) => {
    const customerId = req.params.id;
    const query = `
        SELECT o.order_id, o.total_amount, o.order_date, 
               i.item_name, i.price
        FROM orders o
        LEFT JOIN order_items i ON o.order_id = i.order_id
        WHERE o.customer_id = ?
        ORDER BY o.order_id DESC
    `;
    
    connection.query(query, [customerId], (err, results) => {
        if (err) return res.status(500).json({error: err.message});
        
        const orders = {};
        results.forEach(row => {
            if (!orders[row.order_id]) {
                orders[row.order_id] = {
                    order_id: row.order_id,
                    total_amount: row.total_amount,
                    order_date: row.order_date,
                    items: []
                };
            }
            if (row.item_name) {
                orders[row.order_id].items.push({ name: row.item_name, price: row.price });
            }
        });
        res.json(Object.values(orders));
    });
});

// --- CUSTOMER DATA & ORDERING ---
app.get('/menu', (req, res) => {
    const query = 'SELECT * FROM Menu WHERE is_active = 1';
    connection.query(query, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

app.post('/place-order', (req, res) => {
    const { items, total, customer_id } = req.body;
    const safeCustomerId = customer_id || null; 

    const sqlOrder = "INSERT INTO orders (total_amount, customer_id) VALUES (?, ?)";
    
    connection.query(sqlOrder, [total, safeCustomerId], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: "DB Error (Orders): " + err.message });
        
        const orderId = result.insertId; 
        const sqlItems = "INSERT INTO order_items (order_id, item_name, price) VALUES ?";
        const values = items.map(item => [orderId, item.item_name, item.price]);

        connection.query(sqlItems, [values], (err) => {
            if (err) return res.status(500).json({ success: false, error: "DB Error (Items): " + err.message });
            res.json({ success: true, orderId: orderId });
        });
    });
});

// --- ADMIN MANAGEMENT ROUTES ---
app.get('/admin/customers', (req, res) => {
    const query = `
        SELECT 
            c.customer_id, c.username, c.mobile, c.password, c.created_at,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) as total_orders,
            (SELECT COALESCE(SUM(total_amount), 0) FROM orders o WHERE o.customer_id = c.customer_id) as total_spent
        FROM Customers c
        ORDER BY c.created_at DESC
    `;
    connection.query(query, (err, results) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(results);
    });
});

app.post('/admin/edit-customer', (req, res) => {
    const { customer_id, username, mobile, password } = req.body;
    const query = 'UPDATE Customers SET username = ?, mobile = ?, password = ? WHERE customer_id = ?';
    connection.query(query, [username, mobile, password, customer_id], (err, result) => {
        if (err) return res.status(500).json({ error: "Database error updating customer." });
        res.json({ message: 'Customer updated successfully!' });
    });
});

app.get('/admin/all-items', (req, res) => {
    const query = 'SELECT * FROM Menu';
    connection.query(query, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

app.post('/add-item', (req, res) => {
    const { item_name, category, price } = req.body;
    const query = 'INSERT INTO Menu (item_name, category, price, is_active, in_stock) VALUES (?, ?, ?, 1, 1)';
    connection.query(query, [item_name, category, price], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Item added!', id: result.insertId });
    });
});

app.post('/toggle-item', (req, res) => {
    const { item_id, current_status } = req.body;
    const newStatus = current_status === 1 ? 0 : 1; 
    const query = 'UPDATE Menu SET is_active = ? WHERE item_id = ?';
    connection.query(query, [newStatus, item_id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Visibility updated!' });
    });
}); 

app.post('/toggle-stock', (req, res) => {
    const { item_id, current_stock } = req.body;
    const newStock = current_stock === 1 ? 0 : 1; 
    const query = 'UPDATE Menu SET in_stock = ? WHERE item_id = ?';
    connection.query(query, [newStock, item_id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json({ message: 'Stock status updated!' });
    });
});

app.post('/edit-item', (req, res) => {
    const { item_id, item_name, category, price } = req.body;
    const query = 'UPDATE Menu SET item_name = ?, category = ?, price = ? WHERE item_id = ?';
    connection.query(query, [item_name, category, price, item_id], (err, result) => {
        if (err) return res.status(500).json({ error: "Failed to update item." });
        res.json({ message: 'Item updated successfully!' });
    });
});

app.post('/delete-item', (req, res) => {
    const { item_id } = req.body;
    const query = 'DELETE FROM Menu WHERE item_id = ?';
    connection.query(query, [item_id], (err, result) => {
        if (err) {
            if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(400).json({ error: "Cannot delete: This dish is linked to past orders." });
            return res.status(500).json({ error: "Database error" });
        }
        res.json({ message: 'Item deleted permanently!' });
    });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));