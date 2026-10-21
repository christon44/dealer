-- CreateTable
CREATE TABLE "ThemeInstall" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "themeId" TEXT NOT NULL,
    "assetsHash" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
