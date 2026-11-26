"""REAL data copied from the deployed backend (Railway) on 2026-10-21: business, settings, working hours, catalog."""
BID = "0bfc71e2-0728-4d39-8103-8410b644f945"
PROFILE = {"id": BID, "name": "Brandora Demo Store", "description": None, "category": "Retail", "phone": "01012345678",
           "address": "Cairo, Egypt"}
SETTINGS = {"businessId": BID, "acceptsCash": True, "acceptsOnlinePayment": False, "deliveryEnabled": False,
            "pickupEnabled": True}
HOURS = [{"id": f"h{i}", "businessId": BID, "dayOfWeek": d, "isOpen": o, "opensAt": a, "closesAt": c,
          "createdAt": "2026-10-16T13:43:01.431Z", "updatedAt": "2026-10-16T13:43:01.431Z"}
         for i, (d, o, a, c) in enumerate([
             ("MONDAY", True, "09:00", "21:00"), ("TUESDAY", True, "09:00", "21:00"),
             ("WEDNESDAY", True, "09:00", "21:00"), ("THURSDAY", True, "09:00", "21:00"),
             ("FRIDAY", False, None, None), ("SATURDAY", True, "10:00", "22:00"), ("SUNDAY", True, "09:00", "21:00")])]


def _item(i, key, name, desc, cat, price, track, stock, attrs):
    return {"id": i, "businessId": BID, "externalKey": key, "name": name, "description": desc, "category": cat,
            "basePrice": price, "trackInventory": track, "stockQuantity": stock, "attributes": attrs, "isActive": True,
            "createdAt": "2026-10-17T12:43:17.770Z", "updatedAt": "2026-10-17T12:43:17.812Z"}


CATALOG = [
    _item("f5fa900b-2c55-4160-99e1-e9f5af14601d", "SKU- TEST", "Test", "test import", "Test", "70", True, 6, {"material": "Test"}),
    _item("133cc103-2e70-4e64-bb1c-40600cdccafc", "DUP-002", "Duplicate Product B", "Duplicate SKU test", "Test", "60", True, 4, {"material": "Polyester"}),
    _item("0d9a5116-ad2d-4908-aed4-44dfffc9da9f", "DUP-001", "Duplicate Product A", "Duplicate SKU test", "Test", "50", True, 2, {"material": "Cotton"}),
    _item("d5e3608d-2f89-46c3-b94d-86beb0858738", "SKU-BLANK", "Blank Stock Item", "Stock intentionally blank", "Test", "75.5", False, None, {"material": "Linen"}),
    _item("e17d8509-76a2-4262-8c8c-0b09e6b1c36f", "SKU-ZERO", "Zero Stock Item", "Should enable tracking with zero stock", "Test", "100", True, 0, {"material": "Cotton"}),
    _item("0efe3bf8-6dca-4101-9eb7-4ee6eb2ffce2", "SKU-EXISTING", "Updated Hoodie", None, "Hoodies", "450", True, 7, {"material": "Fleece"}),
    _item("fde347c5-dd42-4e1b-9322-d8b999ea50e2", "SKU-NEW-001", "T-Shirt", "New product", "Shirts", "299.99", True, 10, {"material": "Cotton"}),
]
TSHIRT_ID = "fde347c5-dd42-4e1b-9322-d8b999ea50e2"
HOODIE_ID = "0efe3bf8-6dca-4101-9eb7-4ee6eb2ffce2"
