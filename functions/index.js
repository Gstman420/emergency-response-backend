const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Safe initialization (important for emulator + prod)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const { FieldValue } = admin.firestore; // 🔥 THIS FIXES YOUR ERROR

/**
 * Emergency priority scoring
 */
function scoreEmergency(emergency) {
  let score = emergency.severity * 10;

  if (emergency.type === "fire") score += 5;
  if (emergency.type === "medical") score += 3;
  if (emergency.type === "police") score += 2;

  return score;
}

/**
 * Firestore Trigger
 */
exports.onEmergencyCreate = onDocumentCreated(
  "emergencies/{emergencyId}",
  async (event) => {
    try {
      logger.info("🚨 Emergency created");

      const newEmergency = event.data.data();
      const emergencyId = event.params.emergencyId;

      if (!newEmergency?.requiredResource) {
        logger.warn("❗ Emergency missing requiredResource");
        return;
      }

      // Fetch active emergencies
      const snapshot = await db
        .collection("emergencies")
        .where("status", "==", "active")
        .get();

      if (snapshot.size <= 1) {
        logger.info("ℹ️ Only one emergency — no deadlock possible");
        return;
      }

      const emergencies = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      // Check for resource conflict
      const conflict = emergencies.filter(
        (e) =>
          e.requiredResource === newEmergency.requiredResource &&
          e.id !== emergencyId
      );

      if (conflict.length === 0) return;

      logger.warn("⚠️ DEADLOCK DETECTED");

      // Score & sort
      conflict.push({ id: emergencyId, ...newEmergency });

      conflict.forEach((e) => {
        e.priorityScore = scoreEmergency(e);
      });

      conflict.sort((a, b) => b.priorityScore - a.priorityScore);

      // Highest priority keeps resource
      const winner = conflict[0];
      const losers = conflict.slice(1);

      const batch = db.batch();

      losers.forEach((e) => {
        batch.update(db.collection("emergencies").doc(e.id), {
          status: "waiting",
          deadlockDetected: true,
          updatedAt: FieldValue.serverTimestamp(), // ✅ FIXED
        });
      });

      batch.update(db.collection("emergencies").doc(winner.id), {
        deadlockResolved: true,
        updatedAt: FieldValue.serverTimestamp(), // ✅ FIXED
      });

      await batch.commit();

      logger.info("✅ Deadlock resolved successfully");
    } catch (error) {
      logger.error("🔥 Backend crash:", error);
    }
  }
);
