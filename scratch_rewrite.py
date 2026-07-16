import re

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Replace mysql2 require
content = content.replace("const mysql   = require('mysql2/promise');", "const sqlite3 = require('sqlite3');\nconst { open } = require('sqlite');")

# 2. Replace connection logic
old_connect = """async function connectDB() {
  try {
    // Railway MySQL URL format: mysql://user:password@host:port/database
    if (process.env.MYSQL_URL || process.env.DATABASE_URL) {
      db = await mysql.createPool(process.env.MYSQL_URL || process.env.DATABASE_URL);
    } else {
      db = await mysql.createPool({
        host:     process.env.DB_HOST     || 'localhost',
        user:     process.env.DB_USER     || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME     || 'agriprice',
        port:     process.env.DB_PORT     || 3306,
        waitForConnections: true,
        connectionLimit: 10,
      });
    }"""
new_connect = """async function connectDB() {
  try {
    db = await open({
      filename: './agriprice.db',
      driver: sqlite3.Database
    });
"""
content = content.replace(old_connect, new_connect)

# 3. Fix AUTO_INCREMENT
content = content.replace("AUTO_INCREMENT", "AUTOINCREMENT")

# 4. Fix [rows] = await db.execute -> rows = await db.all
content = re.sub(r'const\s+\[rows\]\s*=\s*await\s+db\.execute\(', r'const rows = await db.all(', content)

# 5. Fix [result] = await db.execute -> result = await db.run
content = re.sub(r'const\s+\[result\]\s*=\s*await\s+db\.execute\(', r'const result = await db.run(', content)
content = re.sub(r'const\s+\[existing\]\s*=\s*await\s+db\.execute\(', r'const existing = await db.all(', content)
content = re.sub(r'const\s+\[orders\]\s*=\s*await\s+db\.execute\(', r'const orders = await db.all(', content)

# 6. Fix await db.execute (without assignment) to await db.run
content = re.sub(r'await\s+db\.execute\(', r'await db.run(', content)

# 7. Fix result.insertId to result.lastID
content = content.replace("result.insertId", "result.lastID")

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Rewrote server.js for SQLite!")
