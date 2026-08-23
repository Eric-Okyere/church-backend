# GraceTrack API — church-backend

The backend for GraceTrack: a REST API (Node.js + Express + MongoDB) for
church attendance — members, services, QR/manual check-in, live counts, CSV
export. Pairs with a separate frontend (see the `church-frontend` project)
that talks to this API over HTTP. Deploys to [Render](https://render.com).

## Getting started locally

1. **Get a MongoDB database.** The free tier of
   [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) is the easiest way:
   sign up, create a free (M0) cluster, add a database user (Database Access)
   and allow your IP (Network Access — or `0.0.0.0/0` to allow from
   anywhere, which you'll need anyway once this runs on Render), then copy
   the connection string from the "Connect" button.

2. **Configure:**

   ```bash
   npm install
   cp .env.example .env
   # edit .env: paste your MONGODB_URI, and set a JWT_SECRET (the command
   # to generate one is in the .env.example comments)
   ```

3. **Seed and run:**

   ```bash
   npm run seed   # creates your admin login (+ sample data)
   npm run dev    # starts the API on http://localhost:4000
   ```

4. Check it's alive: `curl http://localhost:4000/health` → `{"ok":true}`

## API overview

All routes are under `/api`. Every route except `POST /api/auth/login` and
`POST /api/attendance/checkin` (the public self-check-in endpoint a
member's QR code hits) requires an `Authorization: Bearer <token>` header —
get the token from `POST /api/auth/login`.

| Method | Path                                | What it does                                |
| ------ | ----------------------------------- | -------------------------------------------- |
| POST   | `/api/auth/login`                   | Sign in, returns `{ token, user }`           |
| GET    | `/api/auth/me`                      | Current user from the token                  |
| GET    | `/api/dashboard`                    | Everything the admin dashboard needs         |
| GET    | `/api/members`                      | List members (`?active=true`)                |
| GET    | `/api/members/search?q=`            | Name/phone search                            |
| POST   | `/api/members`                      | Add a member                                 |
| GET    | `/api/members/:id`                  | One member                                   |
| PATCH  | `/api/members/:id`                  | Edit name/phone/email                        |
| POST   | `/api/members/:id/deactivate`       | Deactivate                                   |
| POST   | `/api/members/:id/reactivate`       | Reactivate                                   |
| POST   | `/api/members/:id/regenerate-qr`    | Issue a new QR token                         |
| GET    | `/api/members/:id/qrcode`           | QR code as a PNG data URL                    |
| GET    | `/api/services`                     | List services                                |
| POST   | `/api/services`                     | Create a service (`activateNow: true`)       |
| GET    | `/api/services/:id`                 | One service                                  |
| POST   | `/api/services/:id/activate`        | Make it the active service                   |
| POST   | `/api/services/:id/end`             | End it                                       |
| GET    | `/api/services/:id/attendance`      | Attendance list + count (JSON)               |
| GET    | `/api/services/:id/attendance/csv`  | Attendance as a CSV download                 |
| POST   | `/api/attendance/scan`              | Kiosk: check in by scanned QR token          |
| POST   | `/api/attendance/manual`            | Manual check-in by memberId + serviceId      |
| POST   | `/api/attendance/visitor`           | Add a walk-in visitor                        |
| POST   | `/api/attendance/checkin`           | **Public** — the link a member's QR opens    |

## Deploying to Render

1. Push this `church-backend` folder to its own GitHub repo (or a
   subdirectory of a repo — Render lets you set a root directory).
2. On [render.com](https://render.com): New → Web Service → connect the
   repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start.
4. Environment variables (Environment tab) — same names as `.env.example`:
   `MONGODB_URI`, `JWT_SECRET`, `FRONTEND_URL` (your Netlify URL, e.g.
   `https://your-church.netlify.app` — this is what CORS uses to decide
   which frontend is allowed to call this API), `ADMIN_USERNAME`,
   `ADMIN_PASSWORD`, `ADMIN_NAME`.
5. Deploy. Once it's live, run the seed script once against the same
   database — easiest way is to temporarily point your local `.env`'s
   `MONGODB_URI` at the same Atlas cluster (it already is, if you used the
   same one) and run `npm run seed` from your own machine.
6. In MongoDB Atlas → Network Access, make sure `0.0.0.0/0` (allow from
   anywhere) is added — Render's servers don't have a fixed IP on the free
   tier, so Atlas needs to accept connections from any address (Atlas still
   requires the correct username/password either way, so this is normal and
   safe for this setup).

**A note on Render's free tier:** free web services spin down after periods
of inactivity and take ~30-60 seconds to wake back up on the next request.
That's fine for occasional church use, but the first request after a quiet
week (e.g. loading the kiosk before a service) may feel slow — consider a
paid instance if that's a problem for you, or a scheduled health-check ping
to keep it warm.
