const mongoose = require('mongoose');
const database = require("../config/database");

// Schema for tracking read status of announcements
const readStatusSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    readAt: {
        type: Date,
        default: Date.now
    },
    readBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { _id: false });

// Schema for tracking likes/dislikes
const reactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reaction: {
        type: String,
        enum: ['like', 'dislike'],
        required: true
    },
    reactedAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

// Schema for announcement targets
const targetSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['individual', 'team', 'department', 'all'],
        required: true
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: function () {
            return this.type !== 'all';
        }
    },
    targetName: {
        type: String,
        required: function () {
            return this.type !== 'all';
        }
    }
}, { _id: false });

// Main announcement schema
const announcementSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200
    },

    content: {
        type: String,
        required: true,
        trim: true
    },

    // Message priority and read requirements
    isForceRead: {
        type: Boolean,
        default: false,
        required: true
    },

    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium'
    },

    // Targeting information
    targets: {
        type: [targetSchema],
        required: true,
        validate: {
            validator: function (targets) {
                return targets && targets.length > 0;
            },
            message: 'At least one target must be specified'
        }
    },

    // Author information
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    authorName: {
        type: String,
        required: true
    },

    // Timing
    publishAt: {
        type: Date,
        default: Date.now
    },

    expiresAt: {
        type: Date,
        default: null
    },

    // Status tracking
    status: {
        type: String,
        enum: ['draft', 'published', 'archived', 'cancelled'],
        default: 'draft'
    },

    // Read tracking
    readStatus: {
        type: [readStatusSchema],
        default: []
    },

    // Statistics
    stats: {
        totalTargeted: {
            type: Number,
            default: 0
        },
        totalRead: {
            type: Number,
            default: 0
        },
        readPercentage: {
            type: Number,
            default: 0
        }
    },

    // Like/Dislike functionality (optional)
    enableReactions: {
        type: Boolean,
        default: false
    },

    reactions: {
        type: [reactionSchema],
        default: []
    },

    // Reaction statistics
    reactionStats: {
        totalLikes: {
            type: Number,
            default: 0
        },
        totalDislikes: {
            type: Number,
            default: 0
        },
        likePercentage: {
            type: Number,
            default: 0
        }
    },

    // Additional metadata
    tags: [{
        type: String,
        trim: true
    }],

    attachments: [{
        filename: String,
        originalName: String,
        mimeType: String,
        size: Number,
        url: String,
        uploadedAt: {
            type: Date,
            default: Date.now
        }
    }],

    // System fields
    createdAt: {
        type: Date,
        default: Date.now
    },

    updatedAt: {
        type: Date,
        default: Date.now
    },

    lastReadAt: {
        type: Date,
        default: null
    }
});

// Virtual for checking if announcement is active
announcementSchema.virtual('isActive').get(function () {
    const now = new Date();
    return this.status === 'published' &&
        this.publishAt <= now &&
        (this.expiresAt === null || this.expiresAt > now);
});

// Virtual for getting unique readers
announcementSchema.virtual('uniqueReaders').get(function () {
    const uniqueUserIds = new Set(this.readStatus.map(status => status.userId.toString()));
    return Array.from(uniqueUserIds);
});

// Virtual for getting unique reactors
announcementSchema.virtual('uniqueReactors').get(function () {
    const uniqueUserIds = new Set(this.reactions.map(reaction => reaction.userId.toString()));
    return Array.from(uniqueUserIds);
});

// Method to mark as read by a user
announcementSchema.methods.markAsRead = function (userId, readBy) {
    // Check if already read
    const existingRead = this.readStatus.find(status =>
        status.userId.toString() === userId.toString()
    );

    if (!existingRead) {
        this.readStatus.push({
            userId: userId,
            readBy: readBy || userId,
            readAt: new Date()
        });

        this.stats.totalRead = this.readStatus.length;
        this.stats.readPercentage = this.stats.totalTargeted > 0
            ? (this.stats.totalRead / this.stats.totalTargeted) * 100
            : 0;

        this.lastReadAt = new Date();
        this.updatedAt = new Date();
    }

    return this;
};

// Method to add reaction
announcementSchema.methods.addReaction = function (userId, reaction) {
    if (!this.enableReactions) {
        throw new Error('Reactions are not enabled for this announcement');
    }

    // Remove existing reaction from this user
    this.reactions = this.reactions.filter(r => r.userId.toString() !== userId.toString());

    // Add new reaction
    this.reactions.push({
        userId: userId,
        reaction: reaction,
        reactedAt: new Date()
    });

    // Update statistics
    this.reactionStats.totalLikes = this.reactions.filter(r => r.reaction === 'like').length;
    this.reactionStats.totalDislikes = this.reactions.filter(r => r.reaction === 'dislike').length;
    this.reactionStats.likePercentage = this.reactions.length > 0
        ? (this.reactionStats.totalLikes / this.reactions.length) * 100
        : 0;

    this.updatedAt = new Date();
    return this;
};

// Method to remove reaction
announcementSchema.methods.removeReaction = function (userId) {
    this.reactions = this.reactions.filter(r =>
        r.userId.toString() !== userId.toString()
    );

    // Update statistics
    this.reactionStats.totalLikes = this.reactions.filter(r => r.reaction === 'like').length;
    this.reactionStats.totalDislikes = this.reactions.filter(r => r.reaction === 'dislike').length;
    this.reactionStats.likePercentage = this.reactions.length > 0
        ? (this.reactionStats.totalLikes / this.reactions.length) * 100
        : 0;

    this.updatedAt = new Date();
    return this;
};

// Method to get user's reaction
announcementSchema.methods.getUserReaction = function (userId) {
    const reaction = this.reactions.find(r => r.userId.toString() === userId.toString());
    return reaction ? reaction.reaction : null;
};

// Method to check if user has read
announcementSchema.methods.hasUserRead = function (userId) {
    return this.readStatus.some(status => status.userId.toString() === userId.toString());
};

// Method to get read status for a user
announcementSchema.methods.getUserReadStatus = function (userId) {
    return this.readStatus.find(status => status.userId.toString() === userId.toString());
};

// Static method to find announcements for a user
announcementSchema.statics.findForUser = function (userId, userTeam, userDepartment) {
    return this.find({
        status: 'published',
        $or: [
            { 'targets.type': 'all' },
            { 'targets.type': 'individual', 'targets.targetId': userId },
            { 'targets.type': 'team', 'targets.targetId': userTeam },
            { 'targets.type': 'department', 'targets.targetId': userDepartment }
        ],
        $and: [
            { publishAt: { $lte: new Date() } },
            {
                $or: [
                    { expiresAt: null },
                    { expiresAt: { $gt: new Date() } }
                ]
            }
        ]
    }).sort({ priority: -1, publishAt: -1 });
};

// Pre-save middleware to update timestamps
announcementSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

// Pre-save middleware to calculate targeted users count
announcementSchema.pre('save', async function (next) {
    if (this.isModified('targets')) {
        // This would need to be implemented based on your user/team/department models
        // For now, we'll set a placeholder
        this.stats.totalTargeted = this.targets.length;
    }
    next();
});

const Announcement = database.model('announcement', announcementSchema, 'announcement');

module.exports = Announcement;
