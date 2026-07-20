import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function getDbConnection() {
    return open({
        filename: './kai_kitchen.db',
        driver: sqlite3.Database
    });
}

export async function initDatabase() {
    const db = await getDbConnection();
    
    // 1. Create Pantry table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS pantry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            quantity TEXT DEFAULT '1',
            expiry_date DATE NOT NULL,
            added_date DATE DEFAULT CURRENT_DATE,
            storage TEXT DEFAULT 'Pantry'
        )
    `);

    // 2. Create Recipe History Table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipe_name TEXT NOT NULL,
            cooked_date DATE DEFAULT CURRENT_DATE,
            ingredients_used TEXT
        )
    `);

    // 3. Create Shopping List Table (Enhanced with tags & essential flag)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS shopping_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            quantity TEXT DEFAULT '1',
            added_date DATE DEFAULT CURRENT_DATE,
            category TEXT DEFAULT 'Custom Items',
            is_essential INTEGER DEFAULT 0,
            is_checked INTEGER DEFAULT 0,
            source TEXT DEFAULT 'manual'
        )
    `);

    // 4. Create Recipe Logs (for tracking cooked meals with steps & timing)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS recipe_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipe_name TEXT NOT NULL,
            recipe_steps TEXT,
            ingredients_used TEXT,
            cooked_date DATE DEFAULT CURRENT_DATE,
            time_taken_minutes INTEGER
        )
    `);

    // Seed demo values if database is fresh
    const countResult = await db.get("SELECT COUNT(*) as count FROM pantry");
    if (countResult.count === 0) {
        const today = new Date();
        
        const expiredDate = new Date();
        expiredDate.setDate(today.getDate() - 2);

        const soonDate = new Date();
        soonDate.setDate(today.getDate() + 2);

        const freshDate = new Date();
        freshDate.setDate(today.getDate() + 12);

        await db.run(
            "INSERT INTO pantry (name, quantity, expiry_date) VALUES (?, ?, ?)",
            ['Organic Whole Milk', '1 carton', expiredDate.toISOString().split('T')[0]]
        );
        await db.run(
            "INSERT INTO pantry (name, quantity, expiry_date) VALUES (?, ?, ?)",
            ['Fresh Avocado', '2 count', soonDate.toISOString().split('T')[0]]
        );
        await db.run(
            "INSERT INTO pantry (name, quantity, expiry_date) VALUES (?, ?, ?)",
            ['Boneless Chicken Breast', '500g', freshDate.toISOString().split('T')[0]]
        );
        console.log("🌱 Database seeded with mock pantry items.");
    }
}
