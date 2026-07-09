const { getClient } = require("./client");
const { getEdiConfig } = require("./config");

const LOAD_SHIPMENT_QUERY = `
query LoadShipmentForLabel($filter: LoadShipmentFilter, $first: Int) {
  loadShipment(first: $first, filter: $filter) {
    edges {
      node {
        id
        po_number
        load_shipment_type
        load {
          id
          load_number
        }
        load_packings {
          packing_number
          load_po_items {
            external_id
          }
        }
        shipment_notice {
          cartons
          shipment_id
          assigned_scac
          destination
          vendor_name
          status
        }
        po {
          po_number
          vendor_name
          items {
            external_id
            item_bar_code
            vcp_qty
            item_description
            vendor_style
          }
          addresses {
            type
            name
            contact_name
            address
            city
            state
            postal_code
          }
          destinationCenter {
            dc_name
            address_line
            city
            state
            zip_code
          }
        }
      }
    }
  }
}
`;

const normalize = value => String(value ?? "").trim();

const buildLoadFilter = (loadNumber) => ({
    load: {
        load_number: { eq: normalize(loadNumber) },
    },
});

const extractNodes = (data) =>
    (data?.loadShipment?.edges || []).map(edge => edge?.node).filter(Boolean);

const toShipmentSummary = (node, webBaseUrl) => {
    const loadNumber = normalize(node?.load?.load_number);
    const poDc = normalize(node?.po_number || node?.po?.po_number);
    const shipmentDocumentId = node?.id;
    const shipmentId = normalize(node?.shipment_notice?.shipment_id);

    return {
        loadNumber,
        loadDocumentId: node?.load?.id ?? null,
        poDc,
        shipmentDocumentId,
        shipmentId,
        shipmentUrl: shipmentDocumentId != null
            ? `${webBaseUrl.replace(/\/$/, "")}/shipping/shipment/${shipmentDocumentId}`
            : null,
        status: normalize(node?.shipment_notice?.status),
        node,
    };
};

const queryLoadShipments = async (loadNumber, { first = 50 } = {}) => {
    if (!normalize(loadNumber)) throw Object.assign(new Error("loadNumber is required"), { status: 400 });

    const client = await getClient();
    const data = await client.graphql(LOAD_SHIPMENT_QUERY, {
        filter: buildLoadFilter(loadNumber),
        first,
    });

    return extractNodes(data);
};

const findShipments = async ({ loadNumber, poDc } = {}) => {
    const nodes = await queryLoadShipments(loadNumber);
    const { webBaseUrl } = await getEdiConfig();
    const summaries = nodes.map(node => toShipmentSummary(node, webBaseUrl));
    const targetPoDc = normalize(poDc);

    return targetPoDc
        ? summaries.filter(s => s.poDc === targetPoDc)
        : summaries;
};

const findShipmentForLabel = async ({ loadNumber, poDc } = {}) => {
    const matches = await findShipments({ loadNumber, poDc });

    if (!matches.length) {
        const suffix = poDc ? ` / PO-DC ${poDc}` : "";
        throw Object.assign(
            new Error(`No EDI shipment found for load ${loadNumber}${suffix}`),
            { status: 404 }
        );
    }

    if (!poDc && matches.length > 1) {
        throw Object.assign(
            new Error(`Multiple EDI shipments found for load ${loadNumber}; specify poDc`),
            { status: 409, shipments: matches.map(({ node, ...rest }) => rest) }
        );
    }

    if (poDc && matches.length > 1) {
        throw Object.assign(
            new Error(`Multiple EDI shipments found for load ${loadNumber} / PO-DC ${poDc}`),
            { status: 409 }
        );
    }

    return matches[0];
};

module.exports = {
    LOAD_SHIPMENT_QUERY,
    queryLoadShipments,
    findShipments,
    findShipmentForLabel,
    toShipmentSummary,
};
