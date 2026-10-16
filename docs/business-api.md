# Business API

Creation returns HTTP 201; the six existing endpoints return HTTP 200.
Path parameters must be UUIDs. Unknown body
fields are rejected. Errors use the existing Brandora envelope with English
debugging messages and stable codes for Mobile localization. Auth is not part of
this milestone.

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
Creation returns the profile shape below with a generated UUID. The business
and its default settings are saved atomically using a nested Prisma create.
Working hours remain empty until set with the existing PUT endpoint.
This uses existing tables and requires no new migration.

## Profile

`GET /businesses/:businessId` returns:

```json
{
  "id": "f6bc7287-3285-4e19-a819-459c41f0a138",
  "name": "Sample Bakery",
  "description": null,
  "category": null,
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
exists. Otherwise it returns the seven persisted rows Monday through Sunday.

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

Invalid UUIDs or request bodies return 400 VALIDATION_ERROR. Missing businesses
return 404 BUSINESS_NOT_FOUND. No new error codes were introduced. Unexpected
failures use the existing sanitized server-error contract.

In Postman, use a real business UUID and the routes above. PATCH and PUT requests
use Content-Type: application/json with the examples shown. Read back each
resource using GET. Test omitted fields, nullable profile fields, invalid weekdays,
closed days, and a different business UUID to verify isolation.

Apply checked-in migrations on a provisioned database with
`npm.cmd run prisma:deploy`, then run `npm.cmd run prisma:generate` and
`npm.cmd run build`. The new forward migration is
`20261009125310_add_business_profile_settings_working_hours`; it preserves existing
Business, Catalog, Import, and Inventory data.

Deposit and order policies, split shifts, holiday exceptions, overnight opening,
and timezone handling remain outside this MVP.
