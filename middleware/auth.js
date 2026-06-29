import jwt from 'jsonwebtoken';
import { getDatabase } from '../config/database.js';
import { parseJsonField } from '../lib/parse-json-field.js';

export async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No authentication token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = await getDatabase();
    
    const user = await db.get('SELECT * FROM users WHERE id = ? AND is_active = 1', decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      entitiesAccess: parseJsonField(user.entities_access, [])
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function entityAccessMiddleware(req, res, next) {
  try {
    const entityId = req.params.entityId || req.body.entityId;
    
    if (!entityId) {
      return res.status(400).json({ error: 'Entity ID required' });
    }

    // ADMIN can access all; others only their assigned entities
    if (req.user.role !== 'ADMIN' && !req.user.entitiesAccess.includes(entityId)) {
      return res.status(403).json({ error: 'Access denied to this entity' });
    }

    req.entityId = entityId;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Authorization error' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
