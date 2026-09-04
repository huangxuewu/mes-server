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

let seedPromise;

const ensureDocumentCenterSeed = () => {
    if (seedPromise) return seedPromise;

    seedPromise = Promise.all([
        db.document.updateMany(
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
        ),
        ...auditReferences.map((reference) => db.auditReference.updateOne(
            { code: reference.code },
            { $setOnInsert: { ...reference, systemManaged: true } },
            { upsert: true },
        )),
        ...templates.map(([templateKey, title, purpose, responsibilities, requirements, records]) => {
            const contentJson = policyContent(title, purpose, responsibilities, requirements, records);
            return db.document.updateOne(
                { templateKey },
                {
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
    ]).catch((error) => {
        seedPromise = null;
        throw error;
    });

    return seedPromise;
};

module.exports = {
    ensureDocumentCenterSeed,
    policyContent,
};
