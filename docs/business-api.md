# Business API

Creation returns HTTP 201; all seven other Business endpoints return HTTP 200.
Path parameters must be UUIDs. Unknown DTO body fields and list query fields are
rejected. Errors use the Brandora `{ statusCode, code, message, error }` envelope;
message is a string or array of strings. Use stable codes for Mobile localization.

Every route requires `Authorization: Bearer <accessToken>`; see
[Authentication](auth-api.md). POST and GET `/businesses` require a valid User
session, not membership in an existing Business. Creation assigns the authenticated
creator as OWNER atomically with settings. Item/profile/settings/hours requests
require current active OWNER membership in the path Business. Revoked/inactive
membership, foreign Businesses and unowned legacy Businesses are hidden as 404
NOT_FOUND. Knowing an ID does not claim ownership. One User may own multiple Businesses.

| Method | Path | Success |
| --- | --- | --- |
| POST | `/businesses` | 201, profile |
| GET | `/businesses?limit=20&offset=0` | 200, pagination/items |
| GET | `/businesses/:businessId` | 200, profile |
| PATCH | `/businesses/:businessId` | 200, updated profile |
| GET | `/businesses/:businessId/settings` | 200, settings |
| PATCH | `/businesses/:businessId/settings` | 200, updated settings |
| GET | `/businesses/:businessId/working-hours` | 200, stored rows |
| PUT | `/businesses/:businessId/working-hours` | 200, all seven rows |

There is no Business DELETE, ownership-claim or membership-management endpoint here.

## Create a business

`POST /businesses` accepts:

```json
{
  "name": "Sample Bakery",
  "description": "Fresh bread and pastries",
  "category": "Bakery",
  "phone": null,
  "address": null
}
```

Name is required, trimmed, and must contain 1–200 characters. The other
profile fields are optional and nullable, with the limits listed below.
IDs, timestamps, settings, and working hours cannot be supplied here.
Creation returns the profile shape below with a generated UUID. The Business,
default settings and creator's OWNER membership are saved in one transaction.
Working hours remain empty until set with the existing PUT endpoint.
Do not supply userId, ownerId, role or memberships in the body. Existing ownership
schema migrations must already be applied; this operation creates no schema.

## List owned businesses

`GET /businesses?limit=20&offset=0` returns only Businesses with the current User's
active OWNER membership. No businessId or userId query parameter is accepted.
limit defaults to 20, range 1–100. offset defaults to 0 and must be an integer from
0 through 9007199254740991. Unknown query fields are rejected. Order is createdAt
descending, then id descending. Count and items use one repeatable-read snapshot.

```json
{
  "pagination": {
    "limit": 20,
    "offset": 0,
    "totalCount": 1,
    "hasMore": false,
    "nextOffset": null
  },
  "items": [
    {
      "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
      "name": "Sample Bakery",
      "description": "Fresh bread and pastries",
      "category": "Bakery",
      "phone": null,
      "address": null,
      "createdAt": "2026-10-30T12:00:00.000Z",
      "updatedAt": "2026-10-30T12:00:00.000Z"
    }
  ]
}
```

An empty/out-of-range page has items=[], hasMore=false and nextOffset=null.
Items contain the same profile fields as GET one; settings, hours and memberships
are not expanded. `/auth/me` exposes a different compact businesses list, not this
paginated profile envelope.

## Profile

`GET /businesses/:businessId` returns:

```json
{
  "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "name": "Sample Bakery",
  "description": "Fresh bread and pastries",
  "category": "Bakery",
  "phone": null,
  "address": null,
  "createdAt": "2026-10-09T12:00:00.000Z",
  "updatedAt": "2026-10-09T12:00:00.000Z"
}
```

`PATCH /businesses/:businessId` accepts a partial update and returns the complete
profile in the same shape:

```json
{
  "description": "Fresh bread and pastries",
  "category": "Bakery",
  "address": null
}
```

| Field       | Validation                                 |
| ----------- | ------------------------------------------ |
| name        | Non-null string, trimmed, 1–200 characters |
| description | Nullable string, maximum 5,000 characters  |
| category    | Nullable string, maximum 200 characters    |
| phone       | Nullable string, maximum 50 characters     |
| address     | Nullable string, maximum 1,000 characters  |

At least one editable field is required. Omitted fields retain their values;
explicit null clears nullable fields. Text other than name is preserved, including
empty strings and Arabic content. Phone has no country-specific format check.
IDs, timestamps, relations, and operational settings cannot be patched here.
Business.category is a business-profile string, not a product Category or categoryId.

## Settings

`GET /businesses/:businessId/settings` returns the stored settings or these
defaults without writing to the database:

```json
{
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "acceptsCash": true,
  "acceptsOnlinePayment": false,
  "deliveryEnabled": false,
  "pickupEnabled": true
}
```

`PATCH /businesses/:businessId/settings` accepts:

```json
{
  "acceptsCash": false,
  "deliveryEnabled": true
}
```

The response uses the same five fields as GET, with updated values. At least one
flag is required. Each supplied flag must be a boolean; null, strings, numbers,
and unknown fields are rejected. Omitted flags preserve existing values or use
defaults when creating the first row. The businessId primary key guarantees one
settings row per business. Timestamps are stored internally but omitted from this
response. These are preferences, not payment, delivery, or order workflows.

## Working hours

`GET /businesses/:businessId/working-hours` returns an empty array when no schedule
exists. Otherwise it returns persisted rows in Monday-through-Sunday order.
PUT writes all seven days; GET does not synthesize missing rows for partial legacy data.

`PUT /businesses/:businessId/working-hours` accepts a complete weekly schedule:

```json
{
  "days": [
    {
      "dayOfWeek": "MONDAY",
      "isOpen": true,
      "opensAt": "09:00",
      "closesAt": "17:30"
    },
    {
      "dayOfWeek": "TUESDAY",
      "isOpen": true,
      "opensAt": "09:00",
      "closesAt": "17:30"
    },
    {
      "dayOfWeek": "WEDNESDAY",
      "isOpen": true,
      "opensAt": "09:00",
      "closesAt": "17:30"
    },
    {
      "dayOfWeek": "THURSDAY",
      "isOpen": true,
      "opensAt": "09:00",
      "closesAt": "17:30"
    },
    {
      "dayOfWeek": "FRIDAY",
      "isOpen": true,
      "opensAt": "09:00",
      "closesAt": "17:30"
    },
    {
      "dayOfWeek": "SATURDAY",
      "isOpen": false,
      "opensAt": null,
      "closesAt": null
    },
    { "dayOfWeek": "SUNDAY", "isOpen": false }
  ]
}
```

PUT returns the complete seven-row array. Each array member has this shape:

```json
{
  "id": "9a4afc23-8e16-44d8-9437-607214b12485",
  "businessId": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "dayOfWeek": "MONDAY",
  "isOpen": true,
  "opensAt": "09:00",
  "closesAt": "17:30",
  "createdAt": "2026-10-09T12:00:00.000Z",
  "updatedAt": "2026-10-09T12:00:00.000Z"
}
```

Rules:

- Exactly seven unique enum weekdays are required; request order does not matter.
- isOpen is a required boolean. Unknown root or day fields are rejected.
- Open days require both times in 24-hour HH:mm format, from 00:00 to 23:59.
- Closing must be later than opening on the same day. Overnight hours are unsupported.
- Closed days must omit times or use null; non-null times are rejected.
- Missing and null closed-day times are persisted as null.

The database stores times as nullable varchar(5) strings, without timezone
conversion. WorkingHour has a UUID primary key, timestamps, a businessId index,
and a unique constraint on businessId + dayOfWeek. PUT upserts all seven rows in
one Prisma transaction, preserving existing row IDs and creation timestamps.
Failure rolls back the complete schedule. No other business's schedule changes.

## Errors and testing

Missing, expired, revoked or invalid access credentials return 401 UNAUTHORIZED.
The global Auth guard runs before path/body validation. A malformed businessId or
a Business without active ownership normally returns 404 NOT_FOUND before the
service is called. After authorization, invalid request bodies/list queries and
service validation return 400 VALIDATION_ERROR; service-level missing Business
checks return 404 BUSINESS_NOT_FOUND, for example if a record disappears after
authorization. Unexpected failures use the existing sanitized 500 contract.

In Postman, use a valid Bearer token and an owned business UUID. PATCH and PUT requests
use Content-Type: application/json with the examples shown. Read back each
resource using GET. Test omitted fields, nullable profile fields, invalid weekdays,
closed days, and a different business UUID to verify isolation.

The profile/settings/hours schema originated in
`20261009125310_add_business_profile_settings_working_hours`; that is historical,
not the latest migration. Authentication also requires the committed ownership and
session schema. The current application additionally requires the variant-only
inventory migration. Fresh local installation of all ten migrations was verified
separately. Do not infer that migrating an existing production database is safe
from this Business-only document: the latest inventory migration removes legacy
stock columns and refuses incompatible stock/history. Follow the separately
approved [migration and recovery plan](variant-inventory-rollout.md).

After target verification and explicit approval where required, the deployment
command is `npm run prisma:deploy`; Client generation and build use
`npm run prisma:generate` and `npm run build`. These commands are documented here,
not executed as part of this documentation review.

Deposit and order policies, split shifts, holiday exceptions, overnight opening,
and timezone handling remain outside this MVP.
