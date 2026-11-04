// Content audited against expense-manager commit 9a43723 on main. Every module, stage, and
// workflow step below maps to ml-service source files (and, for the bridge
// sections, the backend and frontend call sites) -- see README.md.
const modules = [
  {
    id: "runtime",
    short: "Runtime",
    name: "FastAPI runtime & startup",
    owner: "Application",
    purpose:
      "app.py is the composition root. It exposes 12 route operations (8 behind the operations token), stamps every request with a safe X-Request-ID, and runs four startup handlers in a fixed order: validate configuration, initialize a usable predictor, create MongoDB indexes, then reconcile unfinished lifecycle state.",
    detail:
      "Prediction can stay available without MongoDB, but startup deliberately fails when neither a manifest-backed model nor the protected legacy artifacts can be loaded. Startup also fails when MONGO_CONN is not a Mongo URI, ML_MODEL_ROOT is not writable, or any numeric or boolean setting that was explicitly supplied is invalid.",
    stages: [
      ["Config", "Validate env", "Safe defaults"],
      ["Predictor", "Active bundle", "Legacy fallback"],
      ["Mongo", "Create indexes"],
      ["Recovery", "Runs", "Feedback", "Activation"],
      ["API", "Predict", "Describe", "Retrain"],
      ["Operations", "Health", "Status", "Run history"]
    ]
  },
  {
    id: "access",
    short: "Access",
    name: "Operations token & request correlation",
    owner: "Security",
    purpose:
      "Eight of the twelve operations require the shared X-ML-Operations-Token header: predict-category, generate-description, retrain-model, ml-status, both training-run reads, approve, and reject. Only HEAD /, GET /, /health/live, and /health/ready are open.",
    detail:
      "The guard fails closed: no configured ML_OPERATIONS_TOKEN means 503, a missing or wrong token means 401, and the comparison uses secrets.compare_digest. It runs before any prediction, run record, or lock claim, so a rejected caller does no work. It is one shared secret for reading, predicting, retraining, and approving alike.",
    stages: [
      ["Header", "X-ML-Operations-Token"],
      ["Configured?", "No: 503"],
      ["Compare", "Constant time", "No: 401"],
      ["Handler", "Work starts only now"],
      ["Request ID", "Safe shape or new UUID"],
      ["Response", "ID echoed in header"]
    ]
  },
  {
    id: "prediction",
    short: "Prediction",
    name: "Expense category inference",
    owner: "Online inference",
    purpose:
      "Cleans an expense name, vectorizes it with the live snapshot's TF-IDF vectorizer, predicts with the snapshot's classifier, decodes the label, and reports a confidence percentage plus an abstention flag.",
    detail:
      "Every request obtains one internally consistent runtime snapshot, so vectorizer, model, and label encoder always come from the same bundle. The success body has six fields: expenseName, cleanedText, predictedCategory, confidence, abstained, abstentionReason. An internal failure is caught and returned as an error body with HTTP 200, so callers must inspect the body.",
    stages: [
      ["Input", "expenseName"],
      ["Clean", "Lowercase", "Strip symbols", "Collapse spaces"],
      ["Vectorize", "TF-IDF"],
      ["Classify", "predict", "predict_proba"],
      ["Decode", "Label encoder"],
      ["Response", "Category", "Confidence", "Abstained"]
    ]
  },
  {
    id: "abstention",
    short: "Abstention",
    name: "Confidence abstention policy",
    owner: "Prediction policy",
    purpose:
      "Turns raw forest vote share into either a committed suggestion or an abstention. training/threshold_policy.json holds one global threshold of 0.90 and fifteen empty per-class slots, and the predictor re-reads that file on every request.",
    detail:
      "The policy is labelled synthetic-provisional: it was derived from a calibration run on a heavily duplicated, partly synthetic dataset, and the file itself says per-class values should wait for a retrain through the versioned pipeline or enough real feedback. A missing or unreadable file falls back to a literal 0.90. An abstained prediction is still returned; the app shows it as a suggestion the user must accept.",
    stages: [
      ["Confidence", "max proba x 100"],
      ["Policy file", "Fresh read", "Fallback 0.90"],
      ["Per-class", "All 15 unset today"],
      ["Global", "0.90 threshold"],
      ["Decision", "Below: abstained", "low_confidence"],
      ["Consumers", "Express", "Add-expense UI"]
    ]
  },
  {
    id: "description",
    short: "Description",
    name: "Template description generator",
    owner: "Rule engine",
    purpose:
      "Generates a short expense description from 31 keyword rules, 15 category template lists, and one amount rule.",
    detail:
      "This is deterministic rules plus a random template choice, not an LLM. A keyword match wins first, and the amount rule only applies on the template path. Keywords are matched as substrings in dictionary order, so short keys can fire inside unrelated words: in a live check, web design course returned Electricity bill (via eb), cola returned Cab ride (via ola), and steak dinner returned Tea/snack expense (via tea).",
    stages: [
      ["Input", "Name", "Category", "Amount"],
      ["Clean", "Normalize text"],
      ["Rules", "Substring keyword scan"],
      ["Fallback", "Category templates", "Others"],
      ["Enrich", "Amount > 5000"],
      ["Response", "description"]
    ]
  },
  {
    id: "predictor-manager",
    short: "Model runtime",
    name: "Runtime snapshot & lazy reload",
    owner: "Model serving",
    purpose:
      "Owns the one immutable model snapshot inside each worker process and safely swaps it when the shared active-model manifest advances.",
    detail:
      "The common prediction path is cheap. By default a worker checks the manifest generation at most every five seconds; only a changed generation causes bundle loading and validation. A failed reload keeps the old snapshot live and is counted in bounded diagnostics that /ml-status exposes.",
    stages: [
      ["Snapshot", "Model", "Vectorizer", "Encoder"],
      ["Throttle", "5-second default"],
      ["Manifest", "Compare generation"],
      ["Preload", "Bundle", "Runtime gates"],
      ["Swap", "Atomic reference"],
      ["Fallback", "Keep previous model"]
    ]
  },
  {
    id: "run-lock",
    short: "Runs + lock",
    name: "Persistent runs & distributed lock",
    owner: "Lifecycle control",
    purpose:
      "Records every meaningful retraining attempt in mltrainingruns and ensures only one run can train or activate across threads, Uvicorn workers, or replicas sharing the same MongoDB.",
    detail:
      "A singleton document in mltraininglocks is claimed with one atomic find-and-update. Heartbeats make stale ownership detectable, and release is filtered by runId so an older process cannot unlock a newer run. A run moves through eleven possible statuses; trigger source is limited to cron, manual, or api, and anything else becomes api.",
    stages: [
      ["Request", "Peek active run"],
      ["Record", "queued"],
      ["Claim", "Atomic Mongo update"],
      ["Execute", "running", "Heartbeat"],
      ["Evaluate", "evaluating", "activating or awaiting_approval"],
      ["Terminal", "activated", "failed*", "rejected"]
    ]
  },
  {
    id: "feedback",
    short: "Feedback",
    name: "Feedback reservation lifecycle",
    owner: "Learning data",
    purpose:
      "Atomically moves corrected examples from pending to one training run, then either finalizes them as trained, returns them for retry, or isolates invalid rows for review.",
    detail:
      "The Express backend writes the mlfeedbacks documents; a document is pending only when the user's final category differed from the model's prediction. A feedback record reaches trained only after its model is fully activated. Reservation and finalization filters include both status and trainingRunId, so one run can never touch another run's examples.",
    stages: [
      ["Input", "Backend correction", "pending"],
      ["Reserve", "Atomic per document"],
      ["Validate", "Name", "Canonical category"],
      ["Success", "trained", "Keep run audit"],
      ["Failure", "pending", "Increment attempts"],
      ["Invalid", "needs_review", "Reason"]
    ]
  },
  {
    id: "dataset",
    short: "Dataset",
    name: "Immutable dataset snapshots",
    owner: "Data preparation",
    purpose:
      "Combines the static base dataset (97,056 rows), all previously trained feedback, and the current run's reserved corrections into one reproducible training CSV.",
    detail:
      "Feedback rows are normalized and validated, invalid current rows are quarantined, identical feedback pairs are capped (default 3, base rows are not capped), conflicting labels are counted but kept, and the run-specific snapshot is written once, atomically, and SHA-256 hashed.",
    stages: [
      ["Sources", "Base CSV", "Trained feedback", "Reserved feedback"],
      ["Validate", "Normalize", "Reject invalid"],
      ["Control", "Duplicate cap", "Count conflicts"],
      ["Write", "runs/<runId>/ CSV"],
      ["Protect", "Atomic rename", "No overwrite"],
      ["Record", "Hash", "Row counts", "Reasons"]
    ]
  },
  {
    id: "training",
    short: "Training",
    name: "Trainer & versioned model bundle",
    owner: "Offline ML",
    purpose:
      "Runs training in a child process against the exact snapshot path and writes a self-describing candidate bundle without touching the live model.",
    detail:
      "The trainer builds TF-IDF features (up to 1,000), encodes labels, splits the data into grouped train, validation, and test sets (about 70, 10, and 20 percent), and fits a 30-tree Random Forest on the training split only. The bundle's metadata.json records dataset hash, row counts, metrics, split strategy, and library versions.",
    stages: [
      ["Subprocess", "trainer.py", "Result file"],
      ["Features", "TF-IDF", "Max 1000"],
      ["Labels", "Normalize", "Encode classes"],
      ["Split", "Grouped 70 / 10 / 20"],
      ["Model", "Random Forest", "30 trees"],
      ["Bundle", "3 artifacts", "metadata.json"]
    ]
  },
  {
    id: "evaluation",
    short: "Evaluation",
    name: "Evaluation, baselines & metrics",
    owner: "Model quality",
    purpose:
      "Measures a candidate honestly: grouped splits stop duplicate rows leaking across train and test, and the test split is scored with accuracy, macro-F1, per-class precision/recall/F1, a confusion matrix, calibration, and top-k recall.",
    detail:
      "Three baselines (majority class, keyword vote, and logistic regression on the same TF-IDF features) are scored on the validation split. All of this is persisted for a human to read, but no validation gate consumes macro-F1, calibration, top-k, or the baselines: the gates read accuracy only.",
    stages: [
      ["Group key", "Cleaned name + category"],
      ["Split", "Stratified group", "Fallback tiers"],
      ["Test", "Accuracy", "Macro-F1", "Per class"],
      ["Confidence", "Confusion", "Calibration ECE"],
      ["Ranking", "Top-k recall", "k = 1, 3, 5"],
      ["Baselines", "Majority", "Keyword", "Linear"]
    ]
  },
  {
    id: "validation",
    short: "Validation",
    name: "Nine-gate candidate validation",
    owner: "Quality gate",
    purpose:
      "Rejects an incomplete, incompatible, untraceable, broken, or regressed model before the active manifest can point to it.",
    detail:
      "Gates run in a strict order in their own subprocess and stop at the first hard failure while recording every later gate as skipped. Regression and category-set checks are skipped, not invented, when no active baseline exists. When ML_MAX_ACCURACY_REGRESSION is unset the validator falls back to 0.05, not the 0.02 shown in .env.example and config.py.",
    stages: [
      ["Integrity", "Completeness", "Loadability"],
      ["Compatibility", "Features", "Encoder"],
      ["Traceability", "Dataset metadata"],
      ["Metrics", "Valid accuracy", "Regression limit"],
      ["Runtime", "Smoke predictions"],
      ["Coverage", "Category set"]
    ]
  },
  {
    id: "activation",
    short: "Activation",
    name: "Publish, swap & automatic rollback",
    owner: "Release safety",
    purpose:
      "Makes a validated candidate live only after the publishing process proves it can load the bundle, then protects both manifest and runtime with rollback.",
    detail:
      "Activation preloads first, atomically publishes active.json second, swaps the in-memory snapshot third, and smoke-tests last. Any post-publication failure restores the exact previous snapshot and the previous manifest, or removes the new manifest when none existed.",
    stages: [
      ["Baseline", "Read active manifest"],
      ["Preload", "Candidate", "Runtime gates"],
      ["Publish", "Atomic active.json"],
      ["Swap", "New snapshot"],
      ["Confirm", "Post-swap smoke"],
      ["Finish", "activated", "Feedback", "Cleanup"]
    ]
  },
  {
    id: "promotion",
    short: "Approval + rollback",
    name: "Manual approval & break-glass rollback",
    owner: "Release control",
    purpose:
      "With ML_REQUIRE_MANUAL_APPROVAL on (default off), a validated candidate stops at awaiting_approval. POST approve runs the same activation workflow and POST reject marks it rejected. training/rollback_model.py is an operator CLI that republishes an older on-disk bundle.",
    detail:
      "Rollback is deliberately a script rather than an endpoint, so reverting a live model needs host access and not just the shared token. It only writes a new active.json generation; running workers converge on it within the manifest-check interval. No run record changes when you roll back.",
    stages: [
      ["Flag", "Read fresh each call"],
      ["Pause", "awaiting_approval"],
      ["Approve", "Same activation path"],
      ["Reject", "Terminal rejected"],
      ["CLI list", "Complete bundles"],
      ["CLI rollback", "New manifest generation"]
    ]
  },
  {
    id: "operations",
    short: "Operations",
    name: "Health, status & observability",
    owner: "Operations",
    purpose:
      "Separates process liveness from prediction readiness, exposes sanitized model and run diagnostics, and emits bounded structured lifecycle events.",
    detail:
      "The operations token gates /ml-status and both /training-runs reads; the health probes stay open and cheap. Lifecycle events such as retraining_started, validation_failed, manifest_published, activation_succeeded, awaiting_manual_approval, and artifact_cleanup go through one log_event helper that sanitizes values.",
    stages: [
      ["Liveness", "HTTP process only"],
      ["Readiness", "Snapshot", "Smoke test"],
      ["Status", "Runtime", "Manifest", "Sync"],
      ["History", "Detail", "Filtered list"],
      ["Protect", "Constant-time token"],
      ["Log", "Sanitize", "Bound length"]
    ]
  },
  {
    id: "recovery",
    short: "Recovery",
    name: "Reconciliation & artifact cleanup",
    owner: "Reliability",
    purpose:
      "Repairs known crash windows at startup and keeps rollback-safe model artifacts while deleting only bundles proven safe to remove.",
    detail:
      "Cleanup protects the active, immediately previous, and in-progress bundles, keeps recent superseded and rejected candidates, and never deletes anything younger than the minimum age. Bundles whose run is awaiting_approval, rejected, or failed are classified unknown and are never deleted.",
    stages: [
      ["Reconcile", "Orphaned runs", "Reservations"],
      ["Recover", "Mid-activation state"],
      ["Classify", "Active", "Previous", "In progress"],
      ["Retain", "Count", "Age"],
      ["Safety", "Path check", "Manifest re-check"],
      ["Trigger", "After activation", "Best effort"]
    ]
  },
  {
    id: "bridge",
    short: "Backend bridge",
    name: "Express integration",
    owner: "Backend and frontend",
    purpose:
      "The frontend never calls this service. Express calls it at three sites using ML_ROUTE and the operations-token header: POST /ml/predict-category (after a saved-rule check), the description step of add-expense, and the daily feedback-collector job that triggers retraining.",
    detail:
      "Predict and describe calls use a 5-second timeout and fail soft: a failed description becomes an empty one, a failed prediction becomes a 503. The retrain call and the /ping probe set no timeout. /health/ready ignores ML on purpose, while /health/deps probes GET / with a 3-second timeout and /ping returns 503 when the ML service is down.",
    stages: [
      ["Browser", "Debounced predict"],
      ["Express", "Auth", "Rule check"],
      ["ML call", "Token", "Request ID"],
      ["Fallback", "503 or empty text"],
      ["Feedback", "mlfeedbacks pending"],
      ["Cron", "20:30, 100 pending"]
    ]
  },
  {
    id: "data-assets",
    short: "Data & taxonomy",
    name: "Datasets, taxonomy & legacy bundle",
    owner: "Data",
    purpose:
      "Defines the 15 canonical categories and alias map, the five source files merged into one 97,056-row base dataset, and the fixed legacy artifacts used as the bootstrap model.",
    detail:
      "The legacy bundle on disk is a 100-tree Random Forest over 2,730 TF-IDF features with all 15 classes, which differs from what the trainer now builds (30 trees, up to 1,000 features). It carries no metadata or manifest, so it only serves until the first activation replaces it.",
    stages: [
      ["Categories", "15 canonical"],
      ["Aliases", "medical", "utilities", "emi", "income"],
      ["Base data", "5 sources", "97,056 rows"],
      ["Feedback", "Real corrections"],
      ["Legacy", "model.pkl", "vectorizer.pkl"],
      ["Bundles", "model-<runId>/"]
    ]
  },
  {
    id: "quality",
    short: "Tests & deploy",
    name: "Tests, CI & deployment",
    owner: "Engineering",
    purpose:
      "Verifies behavior across unit, contract, failure-injection, process, and integration tests, runs them in CI against a real MongoDB service, and packages the service as a Docker image.",
    detail:
      "There are 19 test files (179 test functions total). The unit, contract, and failure-injection groups ran at this commit: 153 passed, 2 skipped; the integration and process groups need a reachable MongoDB. The Dockerfile uses python:3.11-slim, mounts /data/models as a volume, and starts two Uvicorn workers. render.yaml defines the backend web and worker services only, not this service.",
    stages: [
      ["Unit", "Config", "Metrics", "Split"],
      ["Contract", "Backend shape"],
      ["Failure", "Injected faults"],
      ["Process", "Restart", "Multi-worker"],
      ["Integration", "Real Mongo", "Real training"],
      ["Image", "Docker", "Volume"]
    ]
  }
];

const workflows = [
  {
    id: "startup",
    category: "Runtime",
    name: "Service startup",
    purpose: "Starts with a usable predictor and repairs recoverable lifecycle state before normal traffic.",
    steps: [
      ["Validate configuration", "A MONGO_CONN that is not a mongodb:// or mongodb+srv:// URI, an unwritable ML_MODEL_ROOT, or any numeric or boolean setting explicitly supplied but invalid stops startup. Absent settings only warn or use defaults."],
      ["Initialize the predictor", "The process loads the active manifest's bundle when valid and passing runtime checks, otherwise it falls back to the protected legacy artifacts."],
      ["Fail only when no model works", "Startup stops if neither the manifest candidate nor the legacy pipeline can be loaded and smoke-validated."],
      ["Create MongoDB indexes", "Run status plus time and model-version indexes are created best-effort; failure affects performance, not correctness."],
      ["Reconcile orphaned runs", "Queued records older than five minutes and running or evaluating records that no longer own the lock are marked failed."],
      ["Reconcile feedback", "Reserved feedback owned by a missing or terminal run returns to pending with attempts incremented; the active lock holder's reservations are left alone."],
      ["Reconcile activation", "Runs left in activating, runs activated with leftover reservations, and a manifest pointing at a pre-activation run are resolved from active.json and the real bundle."],
      ["Emit one summary", "A single run_reconciliation event records counts and sanitized errors. The summary is also kept in memory but no endpoint returns it."]
    ]
  },
  {
    id: "lazy-reload",
    category: "Runtime",
    name: "Multi-worker lazy reload",
    purpose: "Converges each process onto a newly published model without restarting the service.",
    steps: [
      ["Reuse the current snapshot", "Most predictions return immediately while the manifest-check interval (default 5 seconds) has not elapsed."],
      ["Acquire a non-blocking reload lock", "Only one request in a worker performs a due check; concurrent requests keep using the valid old model."],
      ["Read active.json", "The worker compares its loaded generation with the shared manifest generation."],
      ["Preload on change only", "A different generation loads the candidate bundle and runs feature, encoder, and smoke checks outside the write lock."],
      ["Keep the old model on failure", "An invalid manifest or candidate records diagnostics and leaves the current snapshot untouched."],
      ["Swap one complete object", "A successful candidate replaces the process-local RuntimeSnapshot atomically."],
      ["Converge independently", "Other workers repeat the same steps on later prediction requests. This works only where workers share the same artifact filesystem."]
    ]
  },
  {
    id: "predict",
    category: "Inference",
    name: "Category prediction",
    purpose: "Serves one prediction from a complete, internally consistent runtime snapshot.",
    steps: [
      ["Check the operations token", "No configured token returns 503 and a wrong or missing one returns 401, before any inference work."],
      ["Validate the body", "FastAPI and Pydantic require expenseName as a string; a missing field is a 422."],
      ["Obtain the runtime snapshot", "PredictorManager returns model, vectorizer, and encoder as one object, doing a throttled manifest check first."],
      ["Normalize the text", "The name is lowercased, trimmed, stripped of non-alphanumeric characters, and whitespace is collapsed."],
      ["Vectorize, predict, decode", "The fitted TF-IDF vectorizer transforms the text, the forest predicts, and the LabelEncoder returns the category string."],
      ["Calculate confidence", "The maximum predict_proba value becomes a percentage rounded to two decimals."],
      ["Apply the abstention policy", "threshold_policy.json is read fresh and compared against the confidence (see the abstention trace)."],
      ["Return six fields", "expenseName, cleanedText, predictedCategory, confidence, abstained, abstentionReason. An internal exception returns an error body with HTTP 200."]
    ]
  },
  {
    id: "abstention",
    category: "Inference",
    name: "Abstention decision",
    purpose: "Decides whether a prediction is surfaced as a confident suggestion or an abstained one, without ever withholding it.",
    steps: [
      ["Read the policy file", "training/threshold_policy.json is loaded on every request, so a regenerated policy applies to the very next prediction."],
      ["Fall back safely", "A missing, unreadable, or incomplete file produces a minimal policy with a literal global threshold of 0.90."],
      ["Look for a per-class override", "perClassThresholds has a slot for each of the 15 categories, but every slot is null today."],
      ["Use the global threshold", "With no override, 0.90 applies identically to every category."],
      ["Compare on one scale", "Confidence (0 to 100) is divided by 100 and compared strictly below the threshold."],
      ["Flag the result", "Below the threshold returns abstained true with reason low_confidence; otherwise abstained false and a null reason."],
      ["Return the category anyway", "predictedCategory and confidence keep their meaning. The caller decides how to present an abstained suggestion."]
    ]
  },
  {
    id: "description",
    category: "Inference",
    name: "Generate description",
    purpose: "Creates a compact expense description without calling a model or external AI service.",
    steps: [
      ["Check the operations token", "The same fail-closed guard as prediction runs first."],
      ["Validate input", "The request supplies expenseName, expenseCategory, and a numeric expenseAmount."],
      ["Clean the expense name", "Text is lowercased and stripped of symbols for keyword matching."],
      ["Scan keyword rules", "The 31 keyword rules are checked as substrings in dictionary order and the first hit returns directly, which is why short keys such as eb, ola, and tea can match inside other words."],
      ["Choose category fallback", "If no keyword matches, a random template is picked for the category; unknown categories use Others."],
      ["Apply amount enrichment", "On the template path only, amounts above 5,000 prefix the text with High-value."],
      ["Return the text", "The endpoint responds with a single description field."]
    ]
  },
  {
    id: "bridge-predict",
    category: "Backend bridge",
    name: "Prediction from the app",
    purpose: "Shows how a keystroke in the add-expense form becomes a category suggestion, and why the frontend never reaches the ML service.",
    steps: [
      ["Debounce in the browser", "AddExpense waits for at least three characters, cancels any superseded request, and POSTs to /ml/predict-category on the Express backend with the user's bearer token."],
      ["Authenticate in Express", "verifyToken runs and the route requires expenseName."],
      ["Check saved rules first", "A user-saved merchant rule returns its category with confidence 1, source rule, and abstained false, and the ML service is never called."],
      ["Call the ML service", "Otherwise Express POSTs to ML_ROUTE/predict-category with a 5-second timeout, the operations token, and the request ID, and records an ml metric."],
      ["Return the body", "The ML response is passed through with source model added."],
      ["Map failures", "No response from the service gives 503, an ML 4xx is passed through, and an ML 5xx becomes 500. An ML error body that came back with HTTP 200 is forwarded as a 200."],
      ["Present the suggestion", "A confident prediction auto-fills an empty category field. An abstained one is never auto-filled and appears as a suggestion the user must accept."]
    ]
  },
  {
    id: "bridge-feedback",
    category: "Backend bridge",
    name: "Capturing feedback on add-expense",
    purpose: "Records what the user did with a prediction so the retraining loop has real corrections.",
    steps: [
      ["Receive prediction context", "The add-expense request carries mlPredictedCategory, mlConfidence, wasMlCorrected, and mlAbstained; the two booleans are validated and rejected with a 400 if malformed."],
      ["Derive the correction on the server", "Express compares the normalized predicted category with the chosen one itself instead of trusting the client's flag."],
      ["Derive the outcome", "Abstained and corrected combine into accepted, corrected, viewed, or abstained."],
      ["Write the feedback document", "When a real prediction exists, an mlfeedbacks document is saved with status pending only if the prediction was corrected, otherwise null. It is saved before the expense write commits."],
      ["Fill a blank description", "If the user left it empty, Express asks /generate-description with a 5-second timeout and falls back to an empty description on any failure."],
      ["Wait for the daily job", "Nothing is sent to the ML service at this moment; pending feedback just accumulates until the collector runs."]
    ]
  },
  {
    id: "bridge-retrain",
    category: "Backend bridge",
    name: "Daily retrain trigger",
    purpose: "Starts retraining only when enough real corrections have built up.",
    steps: [
      ["Run on the worker", "feedbackCollector fires daily at 20:30 server time under a Redis job lease that fails closed, so an outage skips one day instead of duplicating work."],
      ["Count pending corrections", "It counts mlfeedbacks documents with status pending."],
      ["Apply the threshold", "Fewer than 100 ends the run quietly."],
      ["Call retrain-model", "At 100 or more it POSTs with no body, a fresh correlation ID, and the operations token. No timeout is set on this call."],
      ["Read the answer", "existingRun true means a run was already active; otherwise a new run is queued with its runId logged."],
      ["Handle a 503", "A temporarily unavailable service is logged and retried on the next schedule."]
    ]
  },
  {
    id: "retrain-request",
    category: "Retraining",
    name: "Trigger and claim a run",
    purpose: "Accepts one retraining job across concurrent callers without creating misleading duplicate attempts.",
    steps: [
      ["Check the token first", "A rejected caller creates no run document and starts no thread."],
      ["Check the active lock", "A live owner returns 200 with existingRun true and no new run document."],
      ["Create a queued record", "When the fast path is clear, MongoDB stores a new mltrainingruns attempt; the trigger source falls back to api for anything unrecognized."],
      ["Claim atomically", "claim_or_reclaim tries the unlocked singleton document in one server-side update."],
      ["Recover a stale owner", "A heartbeat older than the timeout (default 30 minutes) can be replaced only through an owner-checked conditional update."],
      ["Resolve a lost race", "An attempt that loses the real claim is deleted and the response names the winning run."],
      ["Start one daemon thread", "Only the process that owns the lock starts background_retrain."],
      ["Return accepted", "The new run receives 202 with status queued and existingRun false; database trouble returns a generic 503."]
    ]
  },
  {
    id: "feedback-reservation",
    category: "Retraining",
    name: "Reserve learning feedback",
    purpose: "Assigns each pending correction to exactly one run and protects it across failures.",
    steps: [
      ["Reconcile older reservations", "Reservations held by a missing or terminal run are returned to pending before the new pass."],
      ["Reserve one document at a time", "find_one_and_update matches status pending and sets reserved with this runId."],
      ["Repeat until empty", "The loop returns the exact set this run reserved."],
      ["Record the reservation", "Reserved IDs are attached to the run document, best-effort."],
      ["Finalize only after activation", "Successful activation sets this run's reserved documents to trained and keeps trainingRunId for audit."],
      ["Return on failure", "Training, validation, or activation failure moves only this run's reservations back to pending with attempts incremented."],
      ["Quarantine invalid rows", "Malformed or unmapped current feedback becomes needs_review instead of retrying forever."]
    ]
  },
  {
    id: "dataset-snapshot",
    category: "Retraining",
    name: "Build a reproducible dataset",
    purpose: "Creates a cumulative, immutable input whose exact bytes and row composition are traceable to the run.",
    steps: [
      ["Read the base dataset", "training/dataset/merged_expenses.csv supplies the 97,056 foundational rows."],
      ["Read cumulative learning", "All trained feedback plus this run's reserved feedback are included without changing older trained records."],
      ["Normalize and validate", "Names are whitespace-normalized and categories go through the shared canonical alias map."],
      ["Cap duplicate feedback", "Identical normalized name and category pairs are limited by ML_FEEDBACK_DUPLICATE_CAP (default 3); base rows are not capped."],
      ["Retain label conflicts", "The same name with multiple valid categories is counted but kept."],
      ["Write once", "training_dataset.csv is written to a temp file, atomically renamed inside runs/<runId>/, and a second write is refused."],
      ["Publish metadata", "SHA-256, row counts, rejection reasons, and conflict count are attached to the run."]
    ]
  },
  {
    id: "train-bundle",
    category: "Retraining",
    name: "Train the candidate bundle",
    purpose: "Produces a versioned candidate in isolation from the live prediction files.",
    steps: [
      ["Launch trainer.py", "The orchestrator passes run ID, model version, dataset path and hash, row counts, baseline accuracy, and a result-file path. The subprocess call has no timeout."],
      ["Clean all input text", "Names are lowercased, stripped of non-alphanumeric characters, and whitespace is collapsed."],
      ["Normalize categories", "Unknown labels are dropped using the same alias map as dataset validation."],
      ["Fit features and labels", "TF-IDF learns up to 1,000 features and LabelEncoder derives the class list from the remaining data."],
      ["Split by group", "Rows are grouped by cleaned name plus category so duplicates never straddle splits, giving about 70 percent train, 10 validation, 20 test (random_state 42)."],
      ["Fit Random Forest", "30 estimators, random_state 42, one job, fitted on the training split only."],
      ["Evaluate", "Test and validation metrics are computed (see the evaluation trace) and attached to the metadata."],
      ["Write atomically", "model.pkl, vectorizer.pkl, labelEncoder.pkl, and metadata.json are written into a private temp directory and renamed to model-<runId> as one complete bundle."]
    ]
  },
  {
    id: "evaluate",
    category: "Retraining",
    name: "Evaluate and compare baselines",
    purpose: "Produces the metrics a human or gate can use to judge a candidate against simpler alternatives.",
    steps: [
      ["Score the test split", "Predictions on the held-out test rows give accuracy, computed after decoding labels back to category names."],
      ["Compute macro-F1 and per-class metrics", "Every category is weighted equally, with precision, recall, F1, and support for each."],
      ["Build the confusion matrix", "Labels and a count matrix are stored in readable category names."],
      ["Measure calibration", "Max-probability confidences are placed into 10 bins and an expected calibration error is reported."],
      ["Measure top-k recall", "Overall, macro, and per-class recall at k = 1, 3, 5, clamped to the class count."],
      ["Score three baselines", "Majority class, a keyword vote (tokens seen at least 5 times with at least 70 percent purity), and logistic regression on the same features are scored on the validation split."],
      ["Persist, do not gate", "Metrics go to metadata.json and the run document. A baseline error is non-fatal; if the main evaluation fails the trainer reports failure and the run ends failed."]
    ]
  },
  {
    id: "validate",
    category: "Retraining",
    name: "Validate all nine gates",
    purpose: "Decides publishability before active.json or any live runtime state changes.",
    steps: [
      ["1 · Completeness", "Require non-empty model, vectorizer, encoder, and metadata files."],
      ["2 · Loadability", "Deserialize all three joblib artifacts."],
      ["3 · Feature compatibility", "Require the vectorizer's vocabulary width to match the model's input width."],
      ["4 · Encoder model compatibility", "Require the encoder and model class counts to agree."],
      ["5 · Dataset metadata consistency", "Require metadata hash and row counts to match the immutable snapshot."],
      ["6 · Valid metrics", "Require a finite numeric accuracy inside 0 to 1."],
      ["7 · Regression threshold", "Reject an accuracy drop beyond ML_MAX_ACCURACY_REGRESSION against the active run's accuracy; with the variable unset the validator uses 0.05. Skipped when no baseline exists."],
      ["8 · Smoke predictions", "Run vectorize, predict, and inverse_transform on four fixed sample inputs."],
      ["9 · Category set comparison", "Reject disappearance of a previously supported category; additions are allowed and the gate is skipped on the first baseline-free run."]
    ]
  },
  {
    id: "activate",
    category: "Activation",
    name: "Activate a validated model",
    purpose: "Publishes and serves a candidate with an all-or-rollback transition.",
    steps: [
      ["Read the previous manifest", "The active version becomes the rollback reference; legacy-fixed is used when no manifest exists."],
      ["Mark activating", "The run stores its previous model version before publication starts."],
      ["Preload the candidate", "The publishing process loads the bundle and repeats feature, encoder, and smoke checks."],
      ["Publish active.json", "A temporary file plus os.replace exposes the next generation atomically."],
      ["Capture the old snapshot", "The exact previous in-memory object is retained for rollback."],
      ["Swap the runtime", "The new complete RuntimeSnapshot becomes live in the publishing worker."],
      ["Run the post-swap smoke test", "Only a working live pipeline allows the run to become activated."],
      ["Finalize learning", "Reserved feedback becomes trained, then bundle cleanup runs as best effort."]
    ]
  },
  {
    id: "activation-rollback",
    category: "Activation",
    name: "Activation failure and rollback",
    purpose: "Keeps the previous live model available when publication or runtime confirmation fails.",
    steps: [
      ["Fail safely before publication", "A preload failure records failed_activation without changing active.json or the live snapshot."],
      ["Treat the manifest write atomically", "If os.replace fails, the prior manifest remains complete and untouched."],
      ["Catch swap or smoke failure", "Any failure after publication enters the full rollback path."],
      ["Restore runtime first", "The exact previous RuntimeSnapshot is swapped back into the publishing process."],
      ["Restore the manifest", "The previous active.json is republished, or the new manifest is removed when none existed before."],
      ["Mark failed_activation", "The run records stage, reason, generation, and rollback outcome."],
      ["Release feedback", "Reserved corrections return to pending for a later run."],
      ["Release the lock last", "No competing activation can start until this outcome is terminal."]
    ]
  },
  {
    id: "manual-approval",
    category: "Activation",
    name: "Manual approval gate",
    purpose: "Optionally puts a human between a validated candidate and the live model.",
    steps: [
      ["Read the flag fresh", "ML_REQUIRE_MANUAL_APPROVAL defaults to off, is read on every call, and an explicitly invalid value stops startup."],
      ["Pause after validation", "With the flag on, a passing candidate is recorded and the run becomes awaiting_approval. No manifest write, swap, or smoke test happens, and the lock is released."],
      ["Review the candidate", "A reviewer uses the stored metrics, per-class results, and baseline comparison (docs/ml has a worked model card)."],
      ["Approve", "POST /training-runs/{runId}/approve returns 404 for an unknown run and 409 unless the run is awaiting_approval."],
      ["Reuse the activation workflow", "Approval calls the same preload, publish, swap, smoke-test function as the automatic path, then marks activated, finalizes feedback, and runs cleanup."],
      ["Handle activation failure", "A failed approval marks failed_activation, returns reserved feedback to pending, and answers 422."],
      ["Reject", "POST /training-runs/{runId}/reject with an optional reason sets terminal rejected, leaving active.json and the bundle untouched. It does not release the run's reserved feedback."]
    ]
  },
  {
    id: "manual-rollback",
    category: "Activation",
    name: "Break-glass rollback",
    purpose: "Lets an operator reactivate an older on-disk bundle after a live regression the gates could not see.",
    steps: [
      ["List promotable bundles", "rollback_model.py --list prints every complete bundle with readable metadata, newest first, and changes nothing."],
      ["Refuse unsafe targets", "It refuses an invalid current manifest, a target that is already active, an incomplete bundle, unreadable metadata, or a bundle that fails to load."],
      ["Publish a new generation", "It writes a new active.json pointing at the chosen bundle, recording the previous version and the next generation number."],
      ["Let workers converge", "Each running worker notices the new generation within the manifest-check interval and reloads it."],
      ["Leave records alone", "No run status, feedback, or bundle changes, and the reason is only echoed back to the operator."]
    ]
  },
  {
    id: "health-status",
    category: "Operations",
    name: "Health and model status",
    purpose: "Separates the process being alive from a worker being able to predict, plus protected diagnostics.",
    steps: [
      ["Check liveness", "/health/live returns alive without touching MongoDB, disk, or the predictor."],
      ["Check readiness", "/health/ready needs a complete snapshot and runs a cheap in-memory smoke prediction, returning 503 when not ready."],
      ["Protect operational detail", "/ml-status requires the operations token and fails closed when none is configured."],
      ["Read runtime metadata", "The status view reports this process's loaded model, run, generation, source, and load time."],
      ["Read the active manifest", "It separately reports the published identity without triggering a reload."],
      ["Compare both views", "synchronized is true only when runtime and manifest point to the same version and generation."],
      ["Expose bounded diagnostics", "Last check, attempt, success, error, and a cumulative failure count are sanitized."]
    ]
  },
  {
    id: "run-history",
    category: "Operations",
    name: "Inspect training runs",
    purpose: "Provides sanitized operational history without exposing raw MongoDB documents.",
    steps: [
      ["Require the operations token", "Both reads use the same constant-time check."],
      ["List recent runs", "GET /training-runs clamps limit to 1 to 100, accepts a validated status filter, and sorts newest first."],
      ["Continue with a cursor", "The last runId is the before cursor; a bad status or cursor is a 400."],
      ["Open one run", "GET /training-runs/{runId} returns 404 for malformed and missing identifiers alike."],
      ["Project safe fields", "Only an approved set of timestamps, status, trigger, model, dataset, metrics, validation, activation, and warning fields is emitted."],
      ["Sanitize failure text", "Free-text reasons are whitespace-collapsed and length-bounded."]
    ]
  },
  {
    id: "crash-recovery",
    category: "Reliability",
    name: "Crash recovery",
    purpose: "Repairs interrupted lifecycle state without manual database editing.",
    steps: [
      ["Sweep orphaned runs", "Old queued and lock-orphaned running or evaluating records become failed at startup."],
      ["Sweep reservations", "Feedback owned by a missing run, or one that failed, failed validation, failed activation, or completed without activating, returns to pending."],
      ["Resolve activating runs", "Manifest identity and bundle completeness decide whether a crash-window run becomes activated or failed_activation."],
      ["Finalize leftovers", "An activated run that still has reserved feedback is finalized to trained."],
      ["Leave paused runs alone", "Runs awaiting approval are not touched. A rejected run is not in the set that releases feedback."],
      ["Back off on doubt", "A stale-looking run that is not yet formally failed is skipped so two runs never claim the same feedback."]
    ]
  },
  {
    id: "artifact-cleanup",
    category: "Reliability",
    name: "Artifact cleanup",
    purpose: "Removes only model bundles proven safe to delete.",
    steps: [
      ["Classify every bundle", "Directories become active, rollback-protected, in-progress, validated-not-activated, failed-validation, failed-activation, orphaned, or unknown."],
      ["Protect critical versions", "Active, immediately previous, in-progress, and unknown bundles are never deletion candidates."],
      ["Apply retention", "Defaults keep five superseded validated bundles and three rejected ones, and nothing younger than seven days is deleted."],
      ["Verify the path", "Deletion needs a direct, non-symlink child of the model root and a fresh manifest re-check."],
      ["Delete per directory", "One failure is logged and never stops the rest of the plan."],
      ["Run last", "Cleanup happens only after activation and feedback finalization are terminal; a dry run is available from a Python shell."]
    ]
  },
  {
    id: "calibration-policy",
    category: "Offline analysis",
    name: "Calibration to threshold policy",
    purpose: "Shows how the 0.90 abstention threshold was derived and what would let it become per-class.",
    steps: [
      ["Score the legacy model", "calibrate_confidence.py loads the fixed legacy bundle and scores a grouped validation fold of the merged dataset."],
      ["Build per-class curves", "Thresholds from 0.30 to 1.00 in 0.05 steps are checked against precision targets of 0.80, 0.90, and 0.95."],
      ["Write the report", "calibration_report.json records the curves and a methodology caveat: the legacy bundle has no metadata, so the fold cannot be proven disjoint from its training data."],
      ["Turn it into a policy", "threshold_policy.py writes one global threshold of 0.90, fifteen null per-class slots, a provisional trust level, and coverage at candidate thresholds."],
      ["Read the numbers carefully", "The file records about 98.9 percent coverage at 0.90 on that fold, which the caveat above says is likely optimistic."],
      ["Serve it", "The predictor reads the file on every request (see the abstention trace)."],
      ["Know when to redo it", "Re-run both scripts after a retrain through the versioned pipeline or once enough real feedback exists, then fill per-class values only where the new report supports them."]
    ]
  }
];

const stagePalette = [
  ["var(--cyan-soft)", "var(--cyan)"],
  ["var(--violet-soft)", "var(--violet)"],
  ["var(--orange-soft)", "var(--orange)"],
  ["var(--rose-soft)", "var(--rose)"],
  ["var(--green-soft)", "var(--green)"],
  ["var(--cyan-soft)", "var(--cyan)"]
];

const moduleList = document.getElementById("module-list");
const moduleTitle = document.getElementById("module-title");
const modulePurpose = document.getElementById("module-purpose");
const moduleDetail = document.getElementById("module-detail");
const moduleOwner = document.getElementById("module-owner");
const moduleFlow = document.getElementById("module-flow");
const workflowSelect = document.getElementById("workflow-select");
const workflowCategory = document.getElementById("workflow-category");
const workflowTitle = document.getElementById("workflow-title");
const workflowPurpose = document.getElementById("workflow-purpose");
const workflowSteps = document.getElementById("workflow-steps");
const stepCount = document.getElementById("step-count");
const themeToggle = document.getElementById("theme-toggle");

let selectedModule = modules[0].id;
let selectedWorkflow = workflows[0].id;

function renderModuleTabs() {
  moduleList.replaceChildren();

  modules.forEach((module, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "module-tab";
    button.id = `module-tab-${module.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "module-panel");
    button.setAttribute("aria-selected", String(module.id === selectedModule));

    const number = document.createElement("span");
    number.className = "tab-index";
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const label = document.createElement("strong");
    label.textContent = module.short;
    const owner = document.createElement("small");
    owner.textContent = module.owner;
    copy.append(label, owner);
    button.append(number, copy);

    button.addEventListener("click", () => {
      selectedModule = module.id;
      renderModuleTabs();
      renderModule();
    });

    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault();
      const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
      const currentIndex = modules.findIndex((item) => item.id === selectedModule);
      const nextIndex = (currentIndex + direction + modules.length) % modules.length;
      selectedModule = modules[nextIndex].id;
      renderModuleTabs();
      renderModule();
      document.getElementById(`module-tab-${selectedModule}`)?.focus();
    });

    moduleList.appendChild(button);
  });
}

function renderModule() {
  const module = modules.find((item) => item.id === selectedModule) ?? modules[0];
  moduleTitle.textContent = module.name;
  modulePurpose.textContent = module.purpose;
  moduleDetail.textContent = module.detail;
  moduleOwner.textContent = module.owner;
  document.getElementById("module-panel").setAttribute("aria-labelledby", `module-tab-${module.id}`);
  moduleFlow.replaceChildren();

  module.stages.forEach((stage, index) => {
    const stageElement = document.createElement("div");
    stageElement.className = "flow-stage";
    stageElement.style.setProperty("--stage-bg", stagePalette[index % stagePalette.length][0]);
    stageElement.style.setProperty("--stage-color", stagePalette[index % stagePalette.length][1]);

    const stageLabel = document.createElement("span");
    stageLabel.textContent = stage[0];
    stageElement.appendChild(stageLabel);

    stage.slice(1).forEach((node) => {
      const nodeElement = document.createElement("div");
      nodeElement.className = "stage-node";
      nodeElement.textContent = node;
      stageElement.appendChild(nodeElement);
    });

    moduleFlow.appendChild(stageElement);

    if (index < module.stages.length - 1) {
      const arrow = document.createElement("span");
      arrow.className = "stage-arrow";
      arrow.setAttribute("aria-hidden", "true");
      moduleFlow.appendChild(arrow);
    }
  });
}

function buildWorkflowControls() {
  workflowSelect.replaceChildren();
  workflowCategory.replaceChildren();

  let currentCategory = null;
  let currentGroup = null;

  workflows.forEach((workflow) => {
    if (workflow.category !== currentCategory) {
      currentCategory = workflow.category;
      currentGroup = document.createElement("optgroup");
      currentGroup.label = workflow.category;
      workflowSelect.appendChild(currentGroup);

      const groupLabel = document.createElement("span");
      groupLabel.className = "workflow-group-label";
      groupLabel.textContent = workflow.category;
      workflowCategory.appendChild(groupLabel);
    }

    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = workflow.name;
    currentGroup.appendChild(option);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "workflow-chip";
    chip.dataset.workflow = workflow.id;
    chip.setAttribute("aria-pressed", String(workflow.id === selectedWorkflow));
    chip.textContent = workflow.name;
    chip.addEventListener("click", () => {
      selectedWorkflow = workflow.id;
      workflowSelect.value = selectedWorkflow;
      renderWorkflowChips();
      renderWorkflow();
    });
    workflowCategory.appendChild(chip);
  });
}

function renderWorkflowChips() {
  document.querySelectorAll(".workflow-chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.workflow === selectedWorkflow));
  });
}

function renderWorkflow() {
  const workflow = workflows.find((item) => item.id === selectedWorkflow) ?? workflows[0];
  workflowTitle.textContent = workflow.name;
  workflowPurpose.textContent = workflow.purpose;
  stepCount.textContent = workflow.steps.length;
  workflowSteps.replaceChildren();

  workflow.steps.forEach(([title, detail]) => {
    const item = document.createElement("li");
    item.className = "workflow-step";

    const copy = document.createElement("div");
    copy.className = "step-copy";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    copy.append(heading, paragraph);
    item.appendChild(copy);
    workflowSteps.appendChild(item);
  });
}

workflowSelect.addEventListener("change", (event) => {
  selectedWorkflow = event.target.value;
  renderWorkflowChips();
  renderWorkflow();
});

const storedTheme = localStorage.getItem("balensia-architecture-theme");
if (storedTheme === "light") {
  document.body.dataset.theme = "light";
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("balensia-architecture-theme", nextTheme);
  themeToggle.setAttribute("aria-label", `Switch to ${nextTheme === "light" ? "dark" : "light"} theme`);
});

renderModuleTabs();
renderModule();
buildWorkflowControls();
renderWorkflow();

// Smooth scrolling: clicking header navigation or in-page anchors scrolls smoothly
// directly to the section heading, leaving a clean, comfortable 20px gap below the sticky header.
function initSmoothScroll() {
  const header = document.querySelector(".site-header");

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const targetId = anchor.getAttribute("href");
      if (!targetId || targetId === "#") return;

      if (targetId === "#top") {
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
        history.pushState(null, "", "#top");
        return;
      }

      const targetElement = document.querySelector(targetId);
      if (!targetElement) return;

      event.preventDefault();

      const headerHeight = header ? header.offsetHeight : 76;
      const heading = targetElement.querySelector(".section-heading") || targetElement;
      const headingTop = heading.getBoundingClientRect().top + window.scrollY;
      const scrollTarget = headingTop - headerHeight - 20;

      window.scrollTo({
        top: Math.max(0, scrollTarget),
        behavior: "smooth"
      });

      history.pushState(null, "", targetId);
    });
  });
}

// Active navigation highlight based on current scroll position
function initActiveNavSpy() {
  const navLinks = document.querySelectorAll(".desktop-nav a");
  const sections = Array.from(navLinks)
    .map((link) => {
      const id = link.getAttribute("href");
      return id && id.startsWith("#") ? document.querySelector(id) : null;
    })
    .filter(Boolean);

  if (!sections.length) return;

  const onScroll = () => {
    const header = document.querySelector(".site-header");
    const headerHeight = header ? header.offsetHeight : 76;
    const scrollY = window.scrollY + headerHeight + 50;

    let currentSection = null;
    sections.forEach((section) => {
      const heading = section.querySelector(".section-heading") || section;
      const top = heading.getBoundingClientRect().top + window.scrollY;
      if (scrollY >= top) {
        currentSection = section;
      }
    });

    navLinks.forEach((link) => {
      const targetId = link.getAttribute("href");
      const isCurrent = currentSection && targetId === `#${currentSection.id}`;
      link.classList.toggle("active", Boolean(isCurrent));
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

initSmoothScroll();
initActiveNavSpy();
