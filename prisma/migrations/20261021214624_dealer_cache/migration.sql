-- CreateTable
CREATE TABLE "DealerCache" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "dealers" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GeocodedAddress" (
    "address" TEXT NOT NULL PRIMARY KEY,
    "lat" REAL,
    "lng" REAL,
    "updatedAt" DATETIME NOT NULL
);
