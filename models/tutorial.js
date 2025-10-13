const mongoose = require("mongoose");
const { io } = require("../socket/io");
const database = require("../config/database");

// Driver.js Step Configuration Schema
const driverStepsSchema = new mongoose.Schema({
    // The target element to highlight (CSS selector, DOM element reference, or function)
    element: {
        type: String,
        required: true
    },

    // Popover configuration for this step
    popover: {
        // Title and description shown in the popover (HTML supported)
        title: String,
        description: String,

        // Position and alignment of the popover relative to target element
        side: {
            type: String,
            enum: ["top", "right", "bottom", "left"],
            default: "bottom"
        },
        align: {
            type: String,
            enum: ["start", "center", "end"],
            default: "center"
        },

        // Button configuration
        showButtons: [{
            type: String,
            enum: ["next", "previous", "close"]
        }],
        disableButtons: [{
            type: String,
            enum: ["next", "previous", "close"]
        }],

        // Button text customization
        nextBtnText: String,
        prevBtnText: String,
        doneBtnText: String,

        // Progress display
        showProgress: {
            type: Boolean,
            default: false
        },
        progressText: {
            type: String,
            default: "{{current}} of {{total}}"
        },

        // Custom styling
        popoverClass: String,

        // Callbacks (stored as function names to be called later)
        onNextClick: String,
        onPrevClick: String,
        onCloseClick: String,
        onPopoverRender: String
    },

    // Whether to disable interaction with highlighted element
    disableActiveInteraction: {
        type: Boolean,
        default: false
    },

    // Step-level callbacks
    onDeselected: String,
    onHighlightStarted: String,
    onHighlighted: String
});

// Driver.js Global Configuration Schema
const driverConfigSchema = new mongoose.Schema({
    // Animation settings
    animate: {
        type: Boolean,
        default: true
    },

    // Overlay configuration
    overlayColor: {
        type: String,
        default: "black"
    },
    overlayOpacity: {
        type: Number,
        default: 0.5,
        min: 0,
        max: 1
    },
    overlayClickBehavior: {
        type: String,
        enum: ["close", "nextStep"],
        default: "close"
    },
    allowClose: {
        type: Boolean,
        default: true
    },

    // Stage (highlighted area) configuration
    stagePadding: {
        type: Number,
        default: 10
    },
    stageRadius: {
        type: Number,
        default: 5
    },

    // Navigation settings
    smoothScroll: {
        type: Boolean,
        default: false
    },
    allowKeyboardControl: {
        type: Boolean,
        default: true
    },

    // Popover global settings
    popoverClass: String,
    popoverOffset: {
        type: Number,
        default: 10
    },

    // Global button configuration
    showButtons: [{
        type: String,
        enum: ["next", "previous", "close"]
    }],
    disableButtons: [{
        type: String,
        enum: ["next", "previous", "close"]
    }],

    // Global button text
    nextBtnText: String,
    prevBtnText: String,
    doneBtnText: String,

    // Progress settings
    showProgress: {
        type: Boolean,
        default: false
    },
    progressText: {
        type: String,
        default: "{{current}} of {{total}}"
    },

    // Global callbacks
    onNextClick: String,
    onPrevClick: String,
    onCloseClick: String,
    onPopoverRender: String,
    onHighlightStarted: String,
    onHighlighted: String,
    onDeselected: String,
    onDestroyStarted: String,
    onDestroyed: String
});

// Enhanced Guide Schema with Driver.js configuration
const guideSchema = new mongoose.Schema({
    // Driver.js configuration
    driverConfig: driverConfigSchema,

    // Array of steps for the tour
    steps: [driverStepsSchema],

    // Tour metadata
    version: {
        type: String,
        default: "1.0.0"
    },
    author: String,
    tags: [String],

    // Tour settings
    autoStart: {
        type: Boolean,
        default: false
    },
    startDelay: {
        type: Number,
        default: 0
    },

    // Accessibility settings
    skipOnEscape: {
        type: Boolean,
        default: true
    },
    preventInteraction: {
        type: Boolean,
        default: false
    }
});

const solutionSchema = new mongoose.Schema({
    name: String,
    description: String,
    solution: {
        type: String,
        enum: ["guide", "article", "video"],
        default: "guide"
    },
    guide: guideSchema,
    article: String,
    video: String,
    status: {
        type: String,
        enum: ["active", "inactive"],
        default: "active"
    }
});

const tutorialSchema = new mongoose.Schema({
    name: String,
    routeName: String,
    description: String,
    tutorials: [solutionSchema],
}, { timestamps: true });

const Tutorial = database.model("tutorial", tutorialSchema, "tutorial");

Tutorial.watch([], { fullDocument: "updateLookup" })
    .on("change", (change) => {
        switch (change.operationType) {
            case "insert":
            case "update":
            case "replace":
                io.emit("tutorial:update", change.fullDocument);
                break;

            case "delete":
                io.emit("tutorial:delete", change.documentKey._id);
                break;
        }
    });

module.exports = Tutorial;