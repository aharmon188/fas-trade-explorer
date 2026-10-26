"""Read-only ArcGIS Pro session check. Never prints credentials or tokens."""

import json
from urllib.parse import urlparse

from arcgis.gis import GIS


def main() -> None:
    gis = GIS("pro")
    expected_host = "esrifederal.maps.arcgis.com"
    portal_host = urlparse(gis.url).hostname
    properties = gis.properties
    organization_host = (
        f"{properties.get('urlKey', '')}.{properties.get('customBaseUrl', '')}"
    ).lower()
    if portal_host != expected_host and not (
        portal_host == "www.arcgis.com" and organization_host == expected_host
    ):
        raise RuntimeError(
            "Active ArcGIS Pro portal is not the approved esrifederal organization. "
            "Switch the active portal in Pro before continuing."
        )
    user = gis.users.me
    if user is None:
        raise RuntimeError("No authenticated ArcGIS Pro user was available.")
    privileges = set(user.privileges or [])
    required = {"portal:user:createItem", "portal:publisher:publishFeatures"}
    missing = sorted(required - privileges)
    print(json.dumps({
        "portal": gis.url,
        "organizationHost": organization_host,
        "organization": gis.properties.name,
        "organizationId": gis.properties.id,
        "username": user.username,
        "role": user.role,
        "requiredPublishingPrivileges": sorted(required),
        "missingPublishingPrivileges": missing,
        "canPublishHostedFeatures": not missing,
        "operation": "read_only_no_items_created",
    }, indent=2))
    if missing:
        raise RuntimeError("Session works, but required publishing privileges are missing.")


if __name__ == "__main__":
    main()
