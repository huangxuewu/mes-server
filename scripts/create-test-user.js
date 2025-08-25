const mongoose = require('mongoose');
const md5 = require('md5');
const User = require('../models/user');

async function createTestUser() {
    try {
        // Database is already connected via the model import
        console.log('Checking for existing test user...');
        
        // Check if test user already exists
        const existingUser = await User.findOne({ username: 'admin' });
        
        if (existingUser) {
            console.log('Test user already exists');
            return;
        }
        
        // Create test user
        const testUser = new User({
            username: 'admin',
            password: md5('admin123'), // Password: admin123
            email: 'admin@mes.com',
            role: 'admin',
            status: 'Active'
        });
        
        await testUser.save();
        console.log('Test user created successfully:');
        console.log('Username: admin');
        console.log('Password: admin123');
        console.log('Role: admin');
        
    } catch (error) {
        console.error('Error creating test user:', error);
    } finally {
        // Close database connection
        await mongoose.connection.close();
    }
}

// Run the script
createTestUser();
