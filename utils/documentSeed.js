const db = require("../models");

const paragraph = (text) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : undefined,
});

const heading = (text, level = 2) => ({
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
});

const bulletList = (items) => ({
    type: "bulletList",
    content: items.map((item) => ({
        type: "listItem",
        content: [paragraph(item)],
    })),
});

const policyContent = (title, purpose, responsibilities, requirements, records) => ({
    type: "doc",
    content: [
        heading(title, 1),
        paragraph("Starter template — customize this document for your facility, operations, and applicable requirements before approval."),
        heading("Purpose"),
        paragraph(purpose),
        heading("Scope"),
        paragraph("Define the sites, departments, products, processes, workers, and records covered by this policy."),
        heading("Responsibilities"),
        bulletList(responsibilities),
        heading("Policy and procedure"),
        bulletList(requirements),
        heading("Records"),
        bulletList(records),
        heading("Training"),
        paragraph("Identify affected roles, required training, competency checks, and retraining triggers."),
        heading("Review and approval"),
        paragraph("Review at least annually and when regulations, customer requirements, equipment, materials, or processes change."),
    ],
});

const requiredDocumentContent = (title, category) => ({
    type: "doc",
    content: [
        heading(title, 1),
        paragraph(`Required starter — this placeholder preserves the ${category} document in the manufacturing policy library. Replace the guidance with facility-specific content and evidence before approval.`),
        heading("Purpose and requirement"),
        paragraph("Explain why this document is required and identify the laws, customer standards, certifications, or internal controls that apply."),
        heading("Scope"),
        paragraph("Define the sites, departments, workers, products, suppliers, processes, and time periods covered."),
        heading("Owner and responsibilities"),
        bulletList([
            "Name the document owner and approving role.",
            "Define who maintains the process, provides evidence, and follows the requirements.",
            "Identify escalation contacts and deputies for critical responsibilities.",
        ]),
        heading("Requirements and procedure"),
        bulletList([
            "Describe the controls and step-by-step process used at this facility.",
            "State acceptance criteria, frequencies, deadlines, and required approvals.",
            "Explain how exceptions, incidents, or nonconformities are reported and resolved.",
        ]),
        heading("Records and evidence"),
        bulletList([
            "List the forms, logs, reports, permits, certificates, or attachments that demonstrate implementation.",
            "Define where records are stored, who may access them, and how long they are retained.",
            "Link related procedures, work instructions, training, and external requirements.",
        ]),
        heading("Training and communication"),
        paragraph("Identify affected roles, required training or communication, competency checks, and retraining triggers."),
        heading("Review and approval"),
        paragraph("Record the owner, approver, effective date, review frequency, revision history, and next review date."),
    ],
});

const inferDocumentCategory = (title) => {
    const value = String(title || "");
    if (/procedure/i.test(value)) return "Procedure";
    if (/work instruction/i.test(value)) return "Work Instruction";
    if (/manual|handbook/i.test(value)) return "Manual";
    if (/\bplan\b|program|schedule|calendar|timeline/i.test(value)) return "Plan";
    if (/\breport/i.test(value)) return "Report";
    if (/specification|standard/i.test(value)) return "Specification";
    if (/guideline/i.test(value)) return "Guideline";
    if (/\bform\b|certificate|license|permit|agreement/i.test(value)) return "Form";
    if (/record|documentation|inventory|assessment|mapping|information|statement|list/i.test(value)) return "Record";
    if (/policy|code of conduct/i.test(value)) return "Policy";
    return "Other";
};

const templates = [
    ["quality-policy", "Quality Policy", "Define the organization's commitment to consistent product quality, customer requirements, and continual improvement.", ["Leadership sets objectives and provides resources.", "Quality owns the management system.", "All employees follow approved processes."], ["Set measurable quality objectives.", "Monitor performance and address adverse trends.", "Communicate the policy to affected personnel."], ["Quality objectives", "Management review minutes", "Improvement actions"]],
    ["document-control", "Document and Record Control", "Ensure personnel use current, approved information and required records remain identifiable and retrievable.", ["Document owners maintain technical accuracy.", "Approvers authorize releases.", "Users verify they are using the effective revision."], ["Assign an owner and document number.", "Approve before release and retain revision history.", "Remove obsolete copies from points of use.", "Protect records from unauthorized change or loss."], ["Approval history", "Revision history", "Retention schedule"]],
    ["roles-responsibilities", "Roles and Responsibilities", "Define accountability and authority for work that affects product, people, and compliance.", ["Leadership assigns qualified owners.", "Managers maintain role clarity.", "Employees escalate unclear or conflicting duties."], ["Maintain current role descriptions.", "Define deputies for critical duties.", "Review assignments when organization or processes change."], ["Organization chart", "Job descriptions", "Delegation records"]],
    ["risk-change", "Risk and Change Management", "Evaluate operational risk before planned changes are introduced.", ["Change owners describe and coordinate changes.", "Affected functions evaluate risks.", "Approvers confirm controls before release."], ["Assess people, product, process, equipment, supplier, and compliance impacts.", "Document controls, testing, training, and rollback needs.", "Verify effectiveness after implementation."], ["Risk assessments", "Change approvals", "Post-implementation reviews"]],
    ["training-competency", "Training and Competency", "Ensure personnel are trained and competent for assigned work.", ["Managers define competency needs.", "Trainers deliver and assess training.", "Employees perform only authorized work."], ["Train before independent work.", "Evaluate understanding or demonstrated skill.", "Retrain after significant changes or performance gaps."], ["Training matrix", "Attendance records", "Competency assessments"]],
    ["supplier-qualification", "Supplier Qualification", "Control suppliers whose materials or services can affect product or operations.", ["Purchasing maintains approved suppliers.", "Quality defines acceptance criteria.", "Owners monitor supplier performance."], ["Evaluate suppliers before approval.", "Define specifications and change-notification expectations.", "Periodically review delivery, quality, and issue response."], ["Supplier evaluations", "Approved supplier list", "Performance reviews"]],
    ["production-control", "Production Process Control", "Provide consistent instructions and controls for manufacturing operations.", ["Engineering defines process requirements.", "Production follows released instructions.", "Quality verifies required controls."], ["Use approved work instructions and current specifications.", "Identify materials, equipment, tooling, and acceptance criteria.", "Record required process results and deviations."], ["Travelers or batch records", "Process checks", "Deviation records"]],
    ["inspection-release", "Inspection and Product Release", "Prevent product release until specified acceptance activities are complete.", ["Quality defines inspection requirements.", "Authorized personnel record results and release product.", "Production controls nonconforming output."], ["Define incoming, in-process, and final checks.", "Use suitable calibrated equipment.", "Identify release status and authorized releaser."], ["Inspection results", "Certificates", "Release records"]],
    ["traceability", "Identification and Traceability", "Maintain identification and traceability appropriate to product and process risk.", ["Operations preserves identification.", "Warehouse controls status and location.", "Quality defines traceability depth."], ["Identify material, work in process, and finished product.", "Link lots or serials to relevant records.", "Test traceability periodically where required."], ["Lot history", "Inventory transactions", "Traceability test results"]],
    ["maintenance", "Equipment Maintenance", "Keep equipment capable of safe and consistent operation.", ["Equipment owners define maintenance needs.", "Maintenance performs and documents work.", "Users report abnormal conditions."], ["Maintain an equipment register.", "Schedule preventive maintenance by risk and manufacturer guidance.", "Assess product impact after breakdown or overdue maintenance."], ["Maintenance plans", "Work orders", "Breakdown history"]],
    ["calibration", "Calibration and Measurement Control", "Ensure monitoring and measuring equipment is suitable and reliable.", ["Quality controls calibration status.", "Users check status before use.", "Owners assess impact of out-of-tolerance results."], ["Identify controlled equipment.", "Calibrate or verify at defined intervals using traceable standards.", "Protect equipment and record results."], ["Calibration certificates", "Equipment register", "Impact assessments"]],
    ["nonconforming-product", "Nonconforming Product Control", "Prevent unintended use or shipment of nonconforming material or product.", ["Anyone may identify a nonconformance.", "Quality controls disposition.", "Authorized roles approve concessions or rework."], ["Clearly identify and segregate affected product.", "Record the requirement, actual condition, quantity, and source.", "Verify rework and disposition completion."], ["Nonconformance reports", "Disposition approvals", "Reinspection results"]],
    ["capa", "Corrective and Preventive Action", "Address significant or recurring problems by removing causes and verifying effectiveness.", ["Quality coordinates the system.", "Action owners investigate and implement actions.", "Leadership reviews overdue or ineffective actions."], ["Contain immediate risk.", "Use evidence to determine root cause.", "Define actions, owners, due dates, and effectiveness checks."], ["CAPA records", "Root-cause evidence", "Effectiveness reviews"]],
    ["complaints", "Customer Complaint Handling", "Receive, investigate, respond to, and learn from customer complaints.", ["Customer service records complaints.", "Quality determines investigation and escalation.", "Owners complete assigned actions."], ["Log complaints consistently.", "Evaluate product, safety, reporting, and recurrence risk.", "Communicate outcomes and trend data."], ["Complaint log", "Investigation records", "Customer responses"]],
    ["internal-audit", "Internal Audit", "Evaluate whether the management system is implemented and effective.", ["The audit program owner plans audits.", "Independent competent auditors gather evidence.", "Process owners address findings."], ["Use a risk-based audit schedule.", "Define scope and criteria.", "Record objective evidence, findings, corrections, and follow-up."], ["Audit schedule", "Audit reports", "Finding closure evidence"]],
    ["management-review", "Management Review", "Provide leadership oversight of system performance, risks, resources, and improvement.", ["Leadership conducts and acts on reviews.", "Process owners provide accurate inputs.", "A coordinator retains outputs."], ["Review objectives, audits, complaints, quality, suppliers, resources, risks, and prior actions.", "Record decisions, actions, owners, and due dates."], ["Review agenda and minutes", "Performance inputs", "Action log"]],
    ["safety", "Workplace Health and Safety", "Provide a safe and healthy workplace and prevent work-related injury and ill health.", ["Leadership provides controls and resources.", "Supervisors enforce safe work.", "Workers follow controls and report hazards."], ["Identify legal and workplace requirements.", "Assess hazards and apply the hierarchy of controls.", "Consult workers and investigate incidents."], ["Hazard assessments", "Inspections", "Safety training records"]],
    ["incident-response", "Incident and Near-Miss Reporting", "Ensure incidents and near misses receive timely care, reporting, investigation, and corrective action.", ["Workers immediately report events.", "Supervisors secure the area and arrange care.", "Safety coordinates investigation and reporting."], ["Respond to emergencies first.", "Preserve relevant evidence.", "Identify causes and corrective actions.", "Complete required notifications."], ["Incident reports", "Investigation evidence", "Corrective actions"]],
    ["emergency-response", "Emergency Preparedness and Response", "Prepare personnel to respond to foreseeable emergencies.", ["Emergency coordinators maintain plans.", "Wardens or responders carry out assigned roles.", "All personnel follow alarms and instructions."], ["Identify credible scenarios and contacts.", "Maintain evacuation, accountability, shutdown, and recovery instructions.", "Test plans and correct gaps."], ["Emergency plans", "Drill records", "Inspection and action logs"]],
    ["environmental-waste", "Environmental and Waste Management", "Control significant environmental impacts and manage waste responsibly.", ["Operations controls process impacts.", "Environmental owners maintain requirements.", "Employees segregate and report waste correctly."], ["Identify waste streams and environmental risks.", "Define storage, labeling, handling, disposal, and spill controls.", "Use authorized service providers where required."], ["Waste manifests", "Inspections", "Spill and disposal records"]],
];

const requiredTemplateCatalog = [
    ["Policies & Procedures", [
        "Quality Statement",
        "Business Integrity Policy",
        "Supplier Code of Conduct",
        "Anti-Corruption & Bribery Policy",
        "Conflict of Interest Policy",
        "Data Protection Policy",
        "Grievance Mechanism Procedure",
    ]],
    ["Labor & Human Rights", [
        "Anti-Forced Labor Policy",
        "Child Labor Prevention Policy",
        "Freedom of Association Policy",
        "Collective Bargaining Guidelines",
        "Working Hours & Overtime Policy",
        "Minimum Wage Compliance",
        "Digital Wage Payment Policy",
        "Migrant Worker Protection Policy",
        "Worker Accommodation Standards",
        "Non-Discrimination Policy",
        "Sexual Harassment Policy",
        "Equal Employment Opportunity Policy",
        "Non-Retaliation Policy",
        "Gender Equality Policy",
    ]],
    ["Health, Safety & Risk Management", [
        "Health & Safety Policy",
        "Occupational Safety Manual",
        "Emergency Response Plan",
        "Fire Safety Procedures",
        "Personal Protective Equipment (PPE) Guidelines",
        "Machine Safety Standards",
        "Chemical Safety & Handling Procedures",
        "Building Safety Inspection Reports",
        "Electrical Safety Standards",
        "Health Monitoring Program",
        "First Aid & Medical Emergency Procedures",
    ]],
    ["Environmental Compliance", [
        "Environmental Management Policy",
        "Environmental Permits & Licenses",
        "Wastewater Treatment Documentation",
        "Air Emissions Control Records",
        "Hazardous Waste Management Plan",
        "Chemical Inventory & MSDS",
        "Environmental Impact Assessment",
        "Water Usage & Conservation Reports",
        "Environmental Monitoring Reports",
        "Prohibited Chemicals Policy",
        "Waste Management Policy",
    ]],
    ["Quality Management", [
        "Quality Management System Manual",
        "Product Quality Control Procedures",
        "Incoming Material Inspection Records",
        "Finished Product Testing Reports",
        "Approved Supplier List",
        "Corrective Action Procedures",
        "Customer Complaint Handling Procedures",
        "Inspection & Testing Equipment Calibration",
        "Non-Conforming Product Control",
        "Document Control Procedures",
        "Product Specifications",
    ]],
    ["Training & Development", [
        "Worker Training Program",
        "Management Training Records",
        "Safety Training Documentation",
        "Skills Development Program",
        "New Employee Orientation Manual",
        "Competency Assessment Records",
        "Training Calendar & Schedule",
        "Certification & License Records",
        "Training Effectiveness Evaluation",
        "Employee Handbook",
    ]],
    ["Legal & Regulatory Compliance", [
        "Business License & Registration",
        "Tax Registration & Compliance",
        "Business EIN Document",
        "Sales Tax Certificate",
        "Facility Permit",
        "Building Lease Agreement",
        "Insurance Coverage Documentation",
        "Workers Compensation Insurance",
        "Unemployment Insurance",
        "Regulatory Inspection Reports",
        "Product Safety Compliance",
    ]],
    ["Supply Chain Management", [
        "Subcontractor Disclosure Form",
        "Supplier Assessment Reports",
        "Supply Chain Mapping",
        "Raw Material Traceability Records",
        "Purchase Order Management",
        "Inventory Management System",
        "Vendor Performance Evaluation",
        "Contract Management Documentation",
        "Supply Chain Risk Assessment",
    ]],
    ["Financial & Administrative Records", [
        "Financial Statements & Audits",
        "Payroll Records & Documentation",
        "Employee Benefits Documentation",
        "Time & Attendance Records",
        "Social Security & Tax Contributions",
        "Personnel Files & Records",
        "Bank Account & Financial Information",
        "Cost Accounting & Pricing Records",
    ]],
    ["Audit & Continuous Improvement", [
        "Previous Audit Reports",
        "Corrective Action Plans (CAPA)",
        "Root Cause Analysis Documentation",
        "Continuous Improvement Plans",
        "Management Review Meeting Records",
        "Performance Monitoring Reports",
        "Key Performance Indicators (KPI)",
        "Implementation Timeline & Milestones",
        "Third-Party Audit Reports",
    ]],
];

const requiredTemplates = requiredTemplateCatalog.flatMap(([category, titles]) => titles.map((title) => ({
    category,
    title,
    templateKey: `required-${title.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
})));

const auditReferences = [
    {
        code: "SMETA",
        name: "SMETA",
        description: "Sedex Members Ethical Trade Audit reference for labour, health and safety, environment, and business ethics topics.",
        sourceLinks: [{ label: "Sedex SMETA", url: "https://www.sedex.com/solutions/smeta-audit/" }],
    },
    {
        code: "TARGET",
        name: "Target Responsible Sourcing",
        description: "Reference material for documents related to Target responsible sourcing expectations. A badge shows relevance only; it is not a compliance determination.",
        sourceLinks: [{ label: "Target suppliers", url: "https://corporate.target.com/sustainability-governance/responsible-supply-chains/suppliers" }],
    },
];

let migrationPromise;
let referenceSeedPromise;
let templateSeedPromise;

const ensureLegacyDocumentMigration = () => {
    if (migrationPromise) return migrationPromise;
    migrationPromise = db.document.updateMany(
        { title: { $exists: false }, name: { $type: "string" } },
        [{
            $set: {
                title: "$name",
                summary: "Legacy document migrated into Document Center.",
                type: "article",
                folder: "Imported",
                status: "Draft",
                contentJson: {
                    type: "doc",
                    content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: "Review and convert the legacy document content." }],
                    }],
                },
                plainText: "Review and convert the legacy document content.",
                currentRevision: 0,
                isTemplate: false,
                reviewIntervalMonths: 12,
                expiryBehavior: "Warn",
            },
        }],
    ).catch((error) => {
        migrationPromise = null;
        throw error;
    });
    return migrationPromise;
};

const ensureAuditReferenceSeed = () => {
    if (referenceSeedPromise) return referenceSeedPromise;
    referenceSeedPromise = Promise.all(auditReferences.map((reference) => db.auditReference.updateOne(
        { code: reference.code },
        { $setOnInsert: { ...reference, systemManaged: true } },
        { upsert: true },
    ))).catch((error) => {
        referenceSeedPromise = null;
        throw error;
    });
    return referenceSeedPromise;
};

const ensureDocumentTemplateSeed = () => {
    if (templateSeedPromise) return templateSeedPromise;
    templateSeedPromise = Promise.all([
        ...templates.map(([templateKey, title, purpose, responsibilities, requirements, records]) => {
            const contentJson = policyContent(title, purpose, responsibilities, requirements, records);
            return db.document.updateOne(
                { templateKey },
                {
                    $set: { documentCategory: inferDocumentCategory(title) },
                    $setOnInsert: {
                        title,
                        summary: purpose,
                        type: "article",
                        folder: "Policy templates",
                        status: "Published",
                        contentJson,
                        plainText: [title, purpose, ...responsibilities, ...requirements, ...records].join(" "),
                        isTemplate: true,
                        systemManaged: true,
                        templateVersion: 1,
                        currentRevision: 1,
                        publishedAt: new Date(),
                    },
                },
                { upsert: true },
            );
        }),
        db.document.bulkWrite(requiredTemplates.map(({ category, title, templateKey }) => {
            const contentJson = requiredDocumentContent(title, category);
            return {
                updateOne: {
                    filter: { templateKey },
                    update: {
                        $set: { documentCategory: inferDocumentCategory(title) },
                        $setOnInsert: {
                            title,
                            summary: `Required starter · ${category}`,
                            type: "article",
                            folder: "Policy templates",
                            tags: ["Required starter", category],
                            status: "Published",
                            contentJson,
                            plainText: [title, category, "Required starter", "Purpose and requirement", "Scope", "Owner and responsibilities", "Requirements and procedure", "Records and evidence", "Training and communication", "Review and approval"].join(" "),
                            isTemplate: true,
                            systemManaged: true,
                            templateVersion: 1,
                            currentRevision: 1,
                            publishedAt: new Date(),
                        },
                    },
                    upsert: true,
                },
            };
        }), { ordered: false }),
    ]).catch((error) => {
        templateSeedPromise = null;
        throw error;
    });
    return templateSeedPromise;
};

const ensureDocumentCenterSeed = () => Promise.all([
    ensureLegacyDocumentMigration(),
    ensureAuditReferenceSeed(),
    ensureDocumentTemplateSeed(),
]);

const prepareDocumentList = () => ensureLegacyDocumentMigration();

const prepareDocumentTemplates = () => Promise.all([
    ensureLegacyDocumentMigration(),
    ensureDocumentTemplateSeed(),
]);

const prepareAuditReferences = () => ensureAuditReferenceSeed();

module.exports = {
    ensureDocumentCenterSeed,
    prepareDocumentList,
    prepareDocumentTemplates,
    prepareAuditReferences,
    policyContent,
    requiredDocumentContent,
    requiredTemplateCatalog,
    inferDocumentCategory,
};
