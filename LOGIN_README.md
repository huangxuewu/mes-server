# MES System Login Implementation

This document describes the login system implementation for the Manufacturing Execution System (MES).

## Features

- **User Authentication**: Secure login with username and password
- **JWT Tokens**: Stateless authentication using JSON Web Tokens
- **Password Hashing**: MD5 hashing for password security
- **Role-based Access**: Support for different user roles (admin, user, etc.)
- **Modern UI**: Clean and responsive login interface

## API Endpoints

### Authentication Endpoints

1. **GET /api/login** - Render login page
2. **POST /api/login** - User login
3. **POST /api/login/register** - User registration (for testing)
4. **GET /api/login/verify** - Verify JWT token

### Login Request Format

```json
POST /api/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}
```

### Login Response Format

```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "user_id",
    "username": "admin",
    "email": "admin@mes.com",
    "role": "admin",
    "status": "Active"
  }
}
```

## Usage

### 1. Access Login Page

Navigate to `/` in your browser. If not logged in, you'll see the login form directly on the main page.

### 2. Create Test User

Run the test user creation script:

```bash
node scripts/create-test-user.js
```

This creates a test user with:
- Username: `admin`
- Password: `admin123`
- Role: `admin`

### 3. Login via API

```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

### 4. Use JWT Token

Include the JWT token in subsequent API requests:

```bash
curl -X GET http://localhost:3000/api/login/verify \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Authentication Middleware

Use the authentication middleware to protect API routes:

```javascript
const { authenticateToken, requireRole } = require('../middleware/auth');

// Protect route with authentication
router.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'Protected route', user: req.user });
});

// Protect route with role requirement
router.get('/admin-only', authenticateToken, requireRole('admin'), (req, res) => {
  res.json({ message: 'Admin only route' });
});
```

## Security Considerations

1. **JWT Secret**: Change the default JWT secret in production
2. **Password Hashing**: Consider using bcrypt instead of MD5 for better security
3. **HTTPS**: Use HTTPS in production
4. **Token Expiration**: JWT tokens expire after 24 hours
5. **Environment Variables**: Store sensitive data in environment variables

## File Structure

```
├── views/
│   └── login.jade              # Login page template
├── api/
│   └── login/
│       └── index.js            # Login API endpoints
├── middleware/
│   └── auth.js                 # Authentication middleware
├── scripts/
│   └── create-test-user.js     # Test user creation script
└── LOGIN_README.md             # This file
```

## Testing

1. Start the server: `npm start`
2. Navigate to: `http://localhost:3000`
3. You'll see the login form if not authenticated
4. Use test credentials: admin/admin123
5. After login, you'll see the full dashboard
6. Test API endpoints with the returned JWT token

## Error Handling

The login system handles various error scenarios:

- Invalid credentials
- Inactive user accounts
- Missing required fields
- Server errors
- Invalid/expired tokens

All errors return appropriate HTTP status codes and descriptive messages.
