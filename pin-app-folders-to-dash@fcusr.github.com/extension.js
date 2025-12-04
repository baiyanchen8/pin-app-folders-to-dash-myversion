import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Helper to keep track of folder objects
let appFolders = {};

function lookupAppFolder(id) {
    if(!appFolders[id]) {
        // Mocking an App object for the folder
        appFolders[id] = new String(id);
        appFolders[id].is_window_backed = () => false;
        appFolders[id].get_id = () => id;
    }
    return appFolders[id];
}

export default class PinAppFoldersToDash extends Extension {
    enable() {
        this._injectAppDisplay();
        this._injectAppFavorites();
        this._injectDash();
        this._redisplayIcons();
    }

    disable() {
        this._restoreAppDisplay();
        this._restoreAppFavorites();
        this._restoreDash();
        this._redisplayIcons();
    }

    _redisplayIcons() {
        AppFavorites.getAppFavorites().reload();
        
        // Note: The internal structure of overview controls may vary in 46
        let controls = Main.overview._overview._controls;
        if (controls && controls._appDisplay) {
            let apps = controls._appDisplay._orderedItems.slice();
            apps.forEach(icon => {
                controls._appDisplay._removeItem(icon);
            });
            controls._appDisplay._redisplay();
        }
        
        if (controls && controls.dash) {
            controls.dash._queueRedisplay();
        }
    }

    // --- AppDisplay Patches ---

    _injectAppDisplay() {
        this._originalEnsurePlaceholder = AppDisplay.AppDisplay.prototype._ensurePlaceholder;
        this._originalLoadApps = AppDisplay.AppDisplay.prototype._loadApps;
        this._originalInitFolderIcon = AppDisplay.FolderIcon.prototype._init;
        this._originalUpdateName = AppDisplay.FolderIcon.prototype._updateName;

        const extension = this;

        AppDisplay.AppDisplay.prototype._ensurePlaceholder = function(source) {
            if(source instanceof AppDisplay.AppIcon) {
                extension._originalEnsurePlaceholder.call(this, source);
                return;
            }
            if(this._placeholder) {
                return;
            }
            let id = source.id;
            let path = `${this._folderSettings.path}folders/${id}/`;
            this._placeholder = new AppDisplay.FolderIcon(id, path, this);
            this._placeholder.connect('notify::pressed', icon => {
                if(icon.pressed) {
                    this.updateDragFocus(icon);
                }
            });
            this._placeholder.scaleAndFade();
            this._redisplay();
        };

        AppDisplay.AppDisplay.prototype._loadApps = function() {
            let appIcons = extension._originalLoadApps.call(this);
            let appFavorites = AppFavorites.getAppFavorites();
            
            // Filter out favorites from the folder icons list
            let filteredFolderIcons = this._folderIcons.filter(icon => 
                !appFavorites.isFavorite(icon._id)
            );
            
            this._folderIcons.forEach(icon => {
                if(appFavorites.isFavorite(icon._id)) {
                    // If it is a favorite, remove it from the grid and destroy it
                    // Note: appIcons contains the grid icons
                    let index = appIcons.indexOf(icon);
                    if (index > -1) {
                         appIcons.splice(index, 1);
                    }
                    icon.destroy();
                }
            });
            this._folderIcons = filteredFolderIcons;
            return appIcons;
        };

        AppDisplay.FolderIcon.prototype._init = function(id, path, parentView) {
            extension._originalInitFolderIcon.call(this, id, path, parentView);
            this.app = lookupAppFolder(id);
            this.connect('button-press-event', (actor, event) => {
                if(event.get_button() === 3) { // Right click
                    extension._popupMenu.call(this);
                    return Clutter.EVENT_STOP;
                }
            });
            this._menuManager = new PopupMenu.PopupMenuManager(this);
        };

        AppDisplay.FolderIcon.prototype._updateName = function() {
            let item = this.get_parent();
            if(item instanceof Dash.DashItemContainer) {
                this._name = AppDisplay.AppDisplay._getFolderName(this._folder);
                item.setLabelText(this._name);
            } else {
                extension._originalUpdateName.call(this);
            }
        };
    }

    _restoreAppDisplay() {
        if (this._originalEnsurePlaceholder)
            AppDisplay.AppDisplay.prototype._ensurePlaceholder = this._originalEnsurePlaceholder;
        if (this._originalLoadApps)
            AppDisplay.AppDisplay.prototype._loadApps = this._originalLoadApps;
        if (this._originalInitFolderIcon)
            AppDisplay.FolderIcon.prototype._init = this._originalInitFolderIcon;
        if (this._originalUpdateName)
            AppDisplay.FolderIcon.prototype._updateName = this._originalUpdateName;
    }

    // --- Helper for Popup Menu ---

    _popupMenu() {
        this.setForcedHighlight(true);
        // this.fake_release(); // Check if this exists in 46, otherwise remove
        if(!this._menu) {
            let appFavorites = AppFavorites.getAppFavorites();
            let isFavorite = appFavorites.isFavorite(this._id);
            let side = isFavorite ? St.Side.BOTTOM : St.Side.LEFT;
            let label = isFavorite ? _('Unpin') : _('Pin to Dash');
            
            this._menu = new PopupMenu.PopupMenu(this, 0.5, side);
            this._menu.addAction(label, () => {
                if(isFavorite) {
                    appFavorites.removeFavorite(this._id);
                } else {
                    appFavorites.addFavorite(this._id);
                }
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if(!isPoppedUp) {
                    this.setForcedHighlight(false);
                }
            });
            
            // Clean up menu on overview hiding
            Main.overview.connectObject('hiding', () => {
                this._menu.close();
            }, this);
            
            Main.uiGroup.add_actor(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }
        
        // BoxPointer.PopupAnimation.FULL might need adjustment if PopupAnimation is moved
        this._menu.open(BoxPointer.PopupAnimation.FULL);
        this._menuManager.ignoreRelease();
        
        let item = this.get_parent();
        if(item instanceof Dash.DashItemContainer) {
            let controls = Main.overview._overview._controls;
            if (controls && controls.dash)
                controls.dash._syncLabel(item, this);
        }
    }

    // --- AppFavorites Patches ---

    _injectAppFavorites() {
        let appFavoritesPrototype = AppFavorites.getAppFavorites().constructor.prototype;
        
        this._originalAddFavorite = appFavoritesPrototype._addFavorite;
        this._originalAddFavoriteAtPos = appFavoritesPrototype.addFavoriteAtPos;
        this._originalRemoveFavorite = appFavoritesPrototype.removeFavorite;
        this._originalReload = appFavoritesPrototype.reload;

        const extension = this;

        appFavoritesPrototype.reload = function() {
            extension._originalReload.call(this);
            let appDisplay = Main.overview._overview._controls._appDisplay;
            let folders = appDisplay._folderSettings.get_strv('folder-children');
            let ids = global.settings.get_strv(this.FAVORITE_APPS_KEY);
            
            // Ensure this._favorites exists
            if (!this._favorites) this._favorites = {};

            ids.forEach(id => {
                let app = Shell.AppSystem.get_default().lookup_app(id);
                if(app != null && this._parentalControlsManager.shouldShowApp(app.app_info)) {
                    this._favorites[app.get_id()] = app;
                } else if(folders.includes(id)) {
                    this._favorites[id] = lookupAppFolder(id);
                }
            });
        };

        appFavoritesPrototype._addFavorite = function(appId, pos) {
            let appDisplay = Main.overview._overview._controls._appDisplay;
            let folders = appDisplay._folderSettings.get_strv('folder-children');
            
            if(!folders.includes(appId)) {
                return extension._originalAddFavorite.call(this, appId, pos);
            }
            if(appId in this._favorites) {
                return false;
            }
            
            let ids = this._getIds();
            ids.splice(pos === -1 ? ids.length : pos, 0, appId);
            global.settings.set_strv(this.FAVORITE_APPS_KEY, ids);
            return true;
        };

        appFavoritesPrototype.addFavoriteAtPos = function(appId, pos) {
             let appDisplay = Main.overview._overview._controls._appDisplay;
             let folders = appDisplay._folderSettings.get_strv('folder-children');
             
             if(!folders.includes(appId)) {
                 extension._originalAddFavoriteAtPos.call(this, appId, pos);
                 return; // Added return to prevent double add
             }
             
             if(!this._addFavorite(appId, pos)) {
                 return;
             }
             
             let path = `${appDisplay._folderSettings.path}folders/${appId}/`;
             let folder = new Gio.Settings({
                 schema_id: 'org.gnome.desktop.app-folders.folder',
                 path,
             });
             let folderName = AppDisplay.AppDisplay._getFolderName(folder); // Use class static
             let msg = _('%s has been pinned to the dash.').format(folderName);
             Main.overview.setMessage(msg, {
                 forFeedback: true,
                 undoCallback: () => this._removeFavorite(appId),
             });
        };

        appFavoritesPrototype.removeFavorite = function(appId) {
            let appDisplay = Main.overview._overview._controls._appDisplay;
            let folders = appDisplay._folderSettings.get_strv('folder-children');
            
            if(!folders.includes(appId)) {
                extension._originalRemoveFavorite.call(this, appId);
                return; // Added return
            }
            
            let pos = this._getIds().indexOf(appId);
            if (!this._removeFavorite(appId)) {
                return;
            }
            
            let path = `${appDisplay._folderSettings.path}folders/${appId}/`;
            let folder = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders.folder',
                path,
            });
            let folderName = AppDisplay.AppDisplay._getFolderName(folder);
            let msg = _('%s has been unpinned from the dash.').format(folderName);
            Main.overview.setMessage(msg, {
                forFeedback: true,
                undoCallback: () => this._addFavorite(appId, pos),
            });
        };
    }

    _restoreAppFavorites() {
        let appFavoritesPrototype = AppFavorites.getAppFavorites().constructor.prototype;
        if (this._originalAddFavorite)
            appFavoritesPrototype._addFavorite = this._originalAddFavorite;
        if (this._originalAddFavoriteAtPos)
            appFavoritesPrototype.addFavoriteAtPos = this._originalAddFavoriteAtPos;
        if (this._originalRemoveFavorite)
            appFavoritesPrototype.removeFavorite = this._originalRemoveFavorite;
        if (this._originalReload)
            appFavoritesPrototype.reload = this._originalReload;
    }

    // --- Dash Patches ---

    _injectDash() {
        // Warning: getAppFromSource is likely an immutable export in ESM.
        // If this assignment fails or has no effect, drag-and-drop from folder to dash may be broken.
        // We try to patch it on the Dash module object if possible, or the class.
        // Since we imported * as Dash, it is immutable. We cannot patch Dash.getAppFromSource.
        // We must check if it is exposed on the Class or patch the prototype methods calling it.
        
        // For now, we will try to patch the prototype of Dash to handle creation of items
        this._originalCreateAppItem = Dash.Dash.prototype._createAppItem;
        const extension = this;

        Dash.Dash.prototype._createAppItem = function(app) {
            if(app instanceof Shell.App) {
                return extension._originalCreateAppItem.call(this, app);
            }
            
            let appDisplay = Main.overview._overview._controls._appDisplay;
            let id = app.toString();
            let path = `${appDisplay._folderSettings.path}folders/${id}/`;
            let appIcon = new AppDisplay.FolderIcon(id, path, appDisplay);
            
            appIcon.connect('apps-changed', () => {
                appDisplay._redisplay();
                appDisplay._savePages();
                if (appIcon.view) appIcon.view._redisplay();
            });
            
            let item = new Dash.DashItemContainer();
            item.setChild(appIcon);
            
            appIcon.icon.style_class = 'overview-icon';
            if (appIcon.icon._box && appIcon.icon.label) {
                appIcon.icon._box.remove_actor(appIcon.icon.label);
                appIcon.icon.label_actor = appIcon.icon.label = null;
            }
            
            item.setLabelText(AppDisplay.AppDisplay._getFolderName(appIcon._folder));
            appIcon.icon.setIconSize(this.iconSize);
            appIcon.icon.y_align = Clutter.ActorAlign.CENTER;
            
            appIcon.shouldShowTooltip = () =>
                appIcon.hover && (!appIcon._menu || !appIcon._menu.isOpen);
            
            this._hookUpLabel(item);
            return item;
        };

        // Note: Patching getAppFromSource is tricky in ESM. 
        // If the original extension relied on Dash.getAppFromSource being called by GNOME Shell,
        // that specific part (Drag and Drop verification) might need deeper changes 
        // (e.g. patching _handleDragOver on Dash).
    }

    _restoreDash() {
        if (this._originalCreateAppItem)
            Dash.Dash.prototype._createAppItem = this._originalCreateAppItem;
    }
}
