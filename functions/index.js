const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");

const admin = require("firebase-admin");

// ✅ Initialize Admin SDK ONCE
admin.initializeApp();

const db = admin.firestore();

/**
 * Score emergency priority
 */
function scoreEmergency(emergency) {
  let score = emergency.severity * 10;

  if (emergency.type === "fire") score += 5;
  if (emergency.type === "medical") score += 3;
  if (emergency.type === "accident") score += 4;

  return score;
}

/**
 * Trigger when emergency is created
 */
exports.onEmergencyCreate = onDocumentCreated(
  "emergencies/{emergencyId}",
  async (event) => {
    logger.info("🚨 Emergency created");

    const snapshot = event.data;
    if (!snapshot) return;

    // Get open emergencies
    const emergenciesSnap = await db
      .collection("emergencies")
      .where("status", "==", "open")
      .get();

    // Get available resources
    const resourcesSnap = await db
      .collection("resources")
      .where("available", "==", true)
      .get();

    if (emergenciesSnap.size <= resourcesSnap.size) {
      logger.info("ℹ️ Only one emergency — no deadlock possible");
      return;
    }

    logger.warn("⚠️ DEADLOCK DETECTED");

    // Create context request for human decision
    await db.collection("context_requests").add({
      emergencies: emergenciesSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        score: scoreEmergency(doc.data()),
      })),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),

      status: "pending",
    });

    logger.info("🧠 Context request created");
  }
);

/**
 * Trigger when human responds
 */
exports.onContextResponseCreate = onDocumentCreated(
  "context_responses/{responseId}",
  async (event) => {
    logger.info("👤 Human response received");

    const data = event.data.data();
    const chosenEmergencyId = data.chosenEmergencyId;

    // Assign emergency
    await db.collection("emergencies").doc(chosenEmergencyId).update({
      status: "assigned",
    });

    // Allocate one available resource
    const resourceSnap = await db
      .collection("resources")
      .where("available", "==", true)
      .limit(1)
      .get();

    if (!resourceSnap.empty) {
      await resourceSnap.docs[0].ref.update({
        available: false,
      });
    }

    // Log decision
    await db.collection("decisions").add({
      emergencyId: chosenEmergencyId,
      resolvedBy: "human",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("✅ Emergency resolved via human decision");
  }
);
