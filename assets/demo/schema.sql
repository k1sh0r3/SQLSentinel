-- SQL Sentinel demo schema: a tiny e-commerce warehouse.
-- Paste this into the Schema panel (any tab) to try the validator instantly.
CREATE TABLE customers (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(255),
  phone VARCHAR(20),
  country VARCHAR(50),
  created_at TIMESTAMP
);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT,
  total DECIMAL(10,2),
  status VARCHAR(20),
  ordered_at TIMESTAMP
);
CREATE TABLE products (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  price DECIMAL(10,2),
  category VARCHAR(50)
);
CREATE TABLE refunds (
  id INT PRIMARY KEY,
  order_id INT,
  refund_amount DECIMAL(10,2),
  reason TEXT,
  created_at TIMESTAMP
);
