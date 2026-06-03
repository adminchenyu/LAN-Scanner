include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-lan-scanner
PKG_VERSION:=1.1.1
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for LAN Device Scanner
LUCI_DESCRIPTION:=Scan LAN devices by CIDR and show IP, status, latency and MAC.
LUCI_DEPENDS:=+luci-base +rpcd
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -n "$${IPKG_INSTROOT}" ]; then
	chmod 0755 "$${IPKG_INSTROOT}/usr/libexec/lan-scanner" 2>/dev/null || true
	chmod 0755 "$${IPKG_INSTROOT}/usr/libexec/lan-scanner-update-mac-vendors.sh" 2>/dev/null || true
else
	chmod 0755 /usr/libexec/lan-scanner 2>/dev/null || true
	chmod 0755 /usr/libexec/lan-scanner-update-mac-vendors.sh 2>/dev/null || true
	rm -f /tmp/luci-indexcache 2>/dev/null || true
	rm -rf /tmp/luci-modulecache 2>/dev/null || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
