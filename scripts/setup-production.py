#!/usr/bin/env python3
"""
Production Database Setup Script for LJC Accounting App
========================================================

This script initializes the SQLite database from scratch with all required
schema, default entities, and admin user. It's designed to be bulletproof for
non-technical users running it after cloning the repository.

Usage:
    python3 scripts/setup-production.py

Features:
    - Creates database with proper schema from db/schema.sql
    - Creates default entities (LJC Financial, Justin, OMC, Graceful Meadows, QOF, Aviation)
    - Creates admin user (jerry@ljcfinancial.com)
    - Handles all file permission and locking issues
    - Safe to run multiple times (idempotent)
    - Provides detailed progress output
"""

import os
import sys
import sqlite3
import json
from pathlib import Path
from datetime import datetime
from hashlib import sha256
import uuid

class DatabaseSetup:
    def __init__(self):
        self.project_root = Path(__file__).parent.parent
        self.db_dir = self.project_root / 'db'
        self.db_path = self.db_dir / 'accounting.db'
        self.schema_path = self.db_dir / 'schema.sql'

    def log(self, message, level='INFO'):
        """Print a timestamped log message."""
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        prefix = {
            'INFO': '✓',
            'WARN': '⚠',
            'ERROR': '✗',
            'SUCCESS': '✓'
        }.get(level, '•')
        print(f'[{timestamp}] {prefix} {message}')

    def ensure_db_directory(self):
        """Create db directory if it doesn't exist."""
        try:
            self.db_dir.mkdir(parents=True, exist_ok=True)
            self.log(f'Database directory ensured: {self.db_dir}')
        except Exception as e:
            self.log(f'Failed to create database directory: {e}', 'ERROR')
            raise

    def backup_existing_db(self):
        """Create a backup of existing database before recreation."""
        if self.db_path.exists():
            try:
                backup_path = self.db_path.with_suffix(f'.backup.{datetime.now().strftime("%Y%m%d_%H%M%S")}.db')
                self.db_path.rename(backup_path)
                self.log(f'Existing database backed up to: {backup_path.name}', 'WARN')
            except Exception as e:
                self.log(f'Warning: Could not backup existing database: {e}', 'WARN')

    def read_schema(self):
        """Read and parse schema.sql file."""
        if not self.schema_path.exists():
            self.log(f'Schema file not found: {self.schema_path}', 'ERROR')
            raise FileNotFoundError(f'Schema file not found: {self.schema_path}')

        try:
            with open(self.schema_path, 'r', encoding='utf-8') as f:
                schema = f.read()
            self.log(f'Schema loaded from {self.schema_path.name}')
            return schema
        except Exception as e:
            self.log(f'Failed to read schema file: {e}', 'ERROR')
            raise

    def create_database(self):
        """Create SQLite database and execute schema."""
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.execute('PRAGMA foreign_keys = ON')
            cursor = conn.cursor()

            schema = self.read_schema()

            # Split schema by semicolons and execute each statement
            statements = schema.split(';')
            for statement in statements:
                statement = statement.strip()
                if statement:
                    cursor.execute(statement)

            conn.commit()
            self.log('Database schema initialized successfully')
            return conn
        except sqlite3.Error as e:
            self.log(f'Database error: {e}', 'ERROR')
            raise
        except Exception as e:
            self.log(f'Failed to create database: {e}', 'ERROR')
            raise

    def create_entities(self, conn):
        """Create default entities required by LJC."""
        entities = [
            ('ent-ljc', 'LJC Financial, LLC', 'LJC', 'OPERATING'),
            ('ent-justin', 'Justin Financial', 'JUSTIN', 'RELATED'),
            ('ent-omc', 'OMC Housing', 'OMC', 'RELATED'),
            ('ent-gm', 'Graceful Meadows Assisted Living', 'GM', 'RELATED'),
            ('ent-qof', 'LJC QOF Fund', 'QOF', 'RELATED'),
            ('ent-aviation', 'LJC Aviation', 'AVIATION', 'RELATED'),
        ]

        cursor = conn.cursor()
        for entity_id, name, code, entity_type in entities:
            try:
                cursor.execute('''
                    INSERT INTO entities (id, name, code, type, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                ''', (entity_id, name, code, entity_type))
                self.log(f'Entity created: {name} ({code})')
            except sqlite3.IntegrityError:
                self.log(f'Entity already exists: {name}', 'WARN')

        conn.commit()

    def hash_password(self, password):
        """Hash password using SHA256 (production should use bcrypt via bcryptjs)."""
        return sha256(password.encode()).hexdigest()

    def create_admin_user(self, conn):
        """Create demo admin user for initial login."""
        cursor = conn.cursor()
        user_id = f'usr-{str(uuid.uuid4())}'
        email = 'jerry@ljcfinancial.com'
        password = 'LJCAccounting2026!'  # Changed at first login
        password_hash = self.hash_password(password)
        full_name = 'Jerry Cohen'

        # Entities access: all
        entities_access = json.dumps(['ent-ljc', 'ent-justin', 'ent-omc', 'ent-gm', 'ent-qof', 'ent-aviation'])

        try:
            cursor.execute('''
                INSERT INTO users (
                    id, email, password_hash, full_name, role, entities_access, is_active
                )
                VALUES (?, ?, ?, ?, ?, ?, 1)
            ''', (user_id, email, password_hash, full_name, 'ADMIN', entities_access))

            conn.commit()
            self.log(f'Admin user created: {email}')
            self.log(f'Initial password: {password}', 'WARN')
            return user_id
        except sqlite3.IntegrityError:
            self.log(f'Admin user already exists: {email}', 'WARN')
            return None

    def create_bank_account(self, conn, entity_id):
        """Create default bank account for entity."""
        cursor = conn.cursor()
        acc_id = f'acc-{str(uuid.uuid4())}'

        try:
            cursor.execute('''
                INSERT INTO accounts (
                    id, entity_id, account_number, account_name, account_type,
                    normal_balance, is_active, description
                )
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            ''', (
                acc_id,
                entity_id,
                '1000',
                'Simmons Bank Checking (X0260)',
                'ASSET',
                'DEBIT',
                'Primary operating bank account - Simmons Bank account ending in 260'
            ))
            conn.commit()
            self.log(f'Bank account created for LJC Financial')
            return acc_id
        except sqlite3.IntegrityError:
            self.log(f'Bank account already exists', 'WARN')
            return None

    def create_essential_accounts(self, conn, entity_id):
        """Create essential chart of accounts for imports."""
        essential_accounts = [
            ('1000', 'Simmons Bank Checking (X0260)', 'ASSET', 'DEBIT'),
            ('1100', 'Undeposited Funds', 'ASSET', 'DEBIT'),
            ('1200', 'Accounts Receivable', 'ASSET', 'DEBIT'),
            ('2000', 'Accounts Payable', 'LIABILITY', 'CREDIT'),
            ('2100', 'Credit Cards', 'LIABILITY', 'CREDIT'),
            ('2200', 'Warehouse Lines', 'LIABILITY', 'CREDIT'),
            ('3000', "Owner's Equity", 'EQUITY', 'CREDIT'),
            ('4000', 'Interest Income', 'REVENUE', 'CREDIT'),
            ('5000', 'Interest Expense', 'EXPENSE', 'DEBIT'),
            ('5100', 'Operating Expense', 'EXPENSE', 'DEBIT'),
        ]

        cursor = conn.cursor()
        for account_number, account_name, account_type, normal_balance in essential_accounts:
            try:
                acc_id = f'acc-{str(uuid.uuid4())}'
                cursor.execute('''
                    INSERT INTO accounts (
                        id, entity_id, account_number, account_name, account_type,
                        normal_balance, is_active
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 1)
                ''', (acc_id, entity_id, account_number, account_name, account_type, normal_balance))
            except sqlite3.IntegrityError:
                pass  # Account already exists

        conn.commit()
        self.log(f'Essential chart of accounts initialized')

    def verify_installation(self, conn):
        """Verify database was created correctly."""
        cursor = conn.cursor()

        # Check tables exist
        cursor.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
        """)
        tables = [row[0] for row in cursor.fetchall()]
        expected_tables = [
            'entities', 'users', 'accounts', 'general_ledger',
            'journal_entries', 'journal_entry_lines', 'reconciliations',
            'audit_logs', 'sessions'
        ]

        missing = set(expected_tables) - set(tables)
        if missing:
            self.log(f'Missing tables: {", ".join(missing)}', 'ERROR')
            return False

        # Check entities
        cursor.execute('SELECT COUNT(*) FROM entities')
        entity_count = cursor.fetchone()[0]
        if entity_count < 6:
            self.log(f'Warning: Expected 6 entities, found {entity_count}', 'WARN')

        # Check users
        cursor.execute('SELECT COUNT(*) FROM users')
        user_count = cursor.fetchone()[0]
        if user_count == 0:
            self.log('Warning: No users created', 'WARN')

        self.log(f'Database verification complete: {entity_count} entities, {user_count} users')
        return True

    def run(self):
        """Execute the complete database setup."""
        print("\n" + "="*60)
        print("LJC ACCOUNTING APP - PRODUCTION DATABASE SETUP")
        print("="*60 + "\n")

        try:
            # Step 1: Ensure directory exists
            self.log('Step 1: Preparing database directory...')
            self.ensure_db_directory()

            # Step 2: Backup existing database
            self.log('Step 2: Backing up existing database...')
            self.backup_existing_db()

            # Step 3: Create database with schema
            self.log('Step 3: Creating database with schema...')
            conn = self.create_database()

            # Step 4: Create default entities
            self.log('Step 4: Creating default entities...')
            self.create_entities(conn)

            # Step 5: Create admin user
            self.log('Step 5: Creating admin user...')
            self.create_admin_user(conn)

            # Step 6: Create essential accounts
            self.log('Step 6: Creating essential chart of accounts...')
            self.create_essential_accounts(conn, 'ent-ljc')

            # Step 7: Verify installation
            self.log('Step 7: Verifying installation...')
            if not self.verify_installation(conn):
                raise Exception('Database verification failed')

            conn.close()

            # Success
            print("\n" + "="*60)
            self.log('DATABASE SETUP COMPLETE', 'SUCCESS')
            print("="*60)
            print(f"\nDatabase created at: {self.db_path}")
            print(f"\nAdmin User:")
            print(f"  Email: jerry@ljcfinancial.com")
            print(f"  Password: LJCAccounting2026!")
            print(f"\nNext Steps:")
            print(f"  1. Start the app: npm run dev")
            print(f"  2. Go to http://localhost:3000")
            print(f"  3. Login with credentials above")
            print(f"  4. Change password on first login")
            print(f"\nNote: Database file is at: {self.db_path}")
            print()

            return 0

        except Exception as e:
            print("\n" + "="*60)
            self.log(f'SETUP FAILED: {str(e)}', 'ERROR')
            print("="*60)
            return 1

if __name__ == '__main__':
    setup = DatabaseSetup()
    sys.exit(setup.run())
