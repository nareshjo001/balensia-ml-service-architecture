# BALENSIA ML Service Architecture

An interactive, responsive architecture visualizer and comprehensive system map for the BALENSIA Python ML microservice.

Audited against the active codebase at commit [`9a43723`](https://github.com/naresh-jothi/expense-manager/commit/9a43723) on branch `main`.

---

## 1. System Overview & Core Metrics

The BALENSIA ML service is an asynchronous Python service built on FastAPI, Scikit-Learn, and PyMongo. It handles online real-time expense category inference, confidence-based abstention, template description generation, and an automated background retraining lifecycle governed by nine validation gates.

| Dimension | Audited Metric | Implementation Details |
| :--- | :---: | :--- |
| **Route Operations** | **12** | 8 token-guarded via `X-ML-Operations-Token`, 4 open probes (`HEAD /`, `GET /`, `/health/live`, `/health/ready`) |
| **Validation Gates** | **9 Ordered Gates** | Offline candidate quality evaluation before any manifest activation |
| **Test Functions** | **179 Tests** | Across 19 test files (153 passed unit/contract/failure-injection, 2 skipped, plus integration & process tests) |
| **Model Serving** | **PredictorManager** | In-memory immutable snapshot with 5-second throttled atomic reloads |
| **Code Hygiene** | **Clean Contracts** | 3,048 lines of dead code and verbose legacy comments purged in commit `450c2e3` |
| **Design System** | **BALENISA UI** | Dark & light themes, 4px vertical accent lines, custom theme-adaptive scrollbars |

---

## 2. Five-Layer Architecture Model

1. **Ingress & Security Boundary (`app.py`, `status_api.py`)**:
   - 12 route operations verifying inputs using Pydantic schemas.
   - Fail-closed security via `verify_operations_token()` (returns 503 if unconfigured, 401 if invalid).
   - Traceable request correlation with `X-Request-ID` middleware.
2. **Lifecycle Control & Orchestration (`app.py`, `training/retrain_pipeline.py`)**:
   - Non-blocking background retraining thread managing the execution lifecycle.
   - Heartbeat updates tracking stage progress (`createdAt`, `startedAt`, `heartbeatAt`, `completedAt`).
   - Pause for manual human approval (`ML_REQUIRE_MANUAL_APPROVAL`) and automatic rollback on failure.
3. **Durable Coordination & Repositories (`db/mongo.py`, `db/`)**:
   - `training_run_repository.py`: Manages state machine transitions and singleton distributed retraining lock (`mltrainingruns`).
   - `feedback_repository.py`: Atomic reservation and status lifecycle of user category corrections (`mlfeedback`).
4. **Offline Candidate Pipeline (`training/`)**:
   - `dataset_builder.py`: Builds immutable per-run dataset snapshots combining static base data (97,056 rows) and trained feedback.
   - `grouped_split.py`: Grouped train/validation/test splits ensuring identical descriptions never leak across folds.
   - `trainer.py`: Random Forest classifier training in an isolated subprocess.
   - `validate_model.py`: Nine sequential gates checking format, schema, accuracy thresholds, calibration, and regression limits.
5. **Online Serving & Runtime Snapshot (`inference/predictor_manager.py`)**:
   - `active.json` manifest selecting the currently active model bundle.
   - `PredictorManager`: Holds one immutable snapshot per worker, checking manifest generation every 5 seconds for lock-free atomic swaps.
   - Legacy bundle fallback providing seamless bootstrap on fresh installs.

---

## 3. The 9 Ordered Validation Gates

Before any candidate model bundle can be published or activated, `validate_model.py` enforces nine sequential quality gates:

1. **Format Gate**: Bundle directory contains required artifacts (`vectorizer.joblib`, `model.joblib`, `label_encoder.joblib`, `metadata.json`).
2. **Schema Gate**: Metadata conforms to the versioned schema and category taxonomy.
3. **Non-Empty Gate**: Evaluation datasets contain positive samples for all classes.
4. **Latency Gate**: Single-prediction inference time satisfies the maximum latency budget.
5. **Accuracy Gate**: Validation accuracy exceeds the absolute minimum performance threshold.
6. **Top-K Recall Gate**: Top-3 category recall meets quality standards across multi-class predictions.
7. **Abstention Gate**: Confidence abstention policy functions correctly against edge-case inputs.
8. **Calibration Gate**: Predicted probabilities align with empirical accuracy across confidence bins.
9. **Regression Gate**: Candidate accuracy does not regress beyond `ML_MAX_ACCURACY_REGRESSION` relative to the active model.

---

## 4. Key End-to-End Workflows Traced

- **Online Category Inference (`POST /predict-category`)**:
  - Text cleaning and normalization (case folding, whitespace trimming, punctuation stripping).
  - TF-IDF vectorization and Random Forest vote distribution calculation.
  - Global confidence threshold check (0.90): predictions below threshold return `abstained: true` with `reason: low_confidence`, still providing the best category as a suggestion.
- **Express Backend Bridge**:
  - Express checks saved user merchant rules first (`MerchantRule`) with 100% confidence before invoking ML.
  - 5-second fail-soft timeout: prediction failures degrade gracefully without disrupting the expense creation flow.
  - Captures category corrections as feedback; triggers `/retrain-model` at 20:30 when pending corrections ≥ 100.
- **Multi-Worker Lazy Reload (`inference/predictor_manager.py`)**:
  - Worker processes serve predictions from memory with zero database queries.
  - Periodic manifest poll compares `generation` timestamp on disk.
  - Preloads new candidate bundle, validates inference smoke tests, and atomically swaps the reference.
- **Break-Glass Rollback (`training/rollback_model.py`)**:
  - CLI and programmatic rollback mechanism to immediately revert `active.json` to a known previous bundle generation.

---

## 5. Architectural Boundaries & Guarantees

The architecture visualizer organizes all ML service boundaries into four distinct, audited categories:

1. **Guaranteed Capabilities**:
   - Live serving artifacts are strictly immutable (retraining writes isolated per-run bundles).
   - Operations token fails closed (8 of 12 operations return 503/401 without valid credentials).
   - Startup reconciliation repairs interrupted crash windows and orphaned reservations.
   - Confidence-based abstention prevents low-confidence hallucinated categorizations.
2. **Architectural Non-Goals**:
   - No Large Language Models (LLMs) used for descriptions (deterministic keyword rules and category templates).
   - No financial spending forecasting (forecasting is computed by the backend's statistical analyzer).
   - No user financial account access (service operates strictly on anonymized text strings and labels).
3. **Active Limits & Maintenance**:
   - Rejecting a candidate model does not currently un-reserve its associated feedback rows.
   - Manual approval endpoint activates without taking the global training lock.
   - Multi-worker deployments require shared storage (`/data/models`) to synchronize bundle artifacts.
4. **Recently Resolved Improvements**:
   - **Streamlined 24 Source Files**: Removed 3,048 lines of dead code and verbose legacy comments in commit `450c2e3`.
   - **Multi-Worker Atomic Reload**: Throttled 5-second manifest checks swap predictor instances lock-free.
   - **Idempotent Training Run Claims**: Atomic `findOneAndUpdate` and unique index prevent concurrent conflicting retrains.
   - **Theme-Adaptive Scrollbars**: Custom 6px rounded scrollbar matching dark and light color tokens.

---

## 6. View Locally & Deployment

No build steps or npm installations are required:

1. Open `index.html` directly in any browser, or run a local Python server:
   ```bash
   python -m http.server 8080
   ```
2. Open `http://localhost:8080`.

### GitHub Pages Publishing
The static site is fully standalone with relative paths and includes `.github/workflows/pages.yml` for automated GitHub Pages publication.

---

## 7. Technical Standards

- Pure vanilla HTML5, CSS3, and JavaScript (ES2022).
- Zero external build dependencies, package downloads, or CDNs.
- Standardized BALENISA vertical accent line heading pattern (`4px` width, `24px` height).
- Responsive down to mobile widths with dark and light themes.
