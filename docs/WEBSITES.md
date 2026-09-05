# אתרי אינטרנט — מדריך תחזוקה והרחבה

מדריך למי שממשיך את הפיצ'ר (כולל אני, בעוד חצי שנה). מה קורה איפה, מה מותר לשנות, ומה
ישבר בשקט אם תשנו אותו. הרקע וההחלטות: [V1045.md](V1045.md). הכללים המחייבים:
`CLAUDE.md`, בלוק v1.0.45.

---

## 1. המודל בעשר שניות

```
קיצור דרך (shortcut)          כלל הרשאה (rule)
─────────────────────         ────────────────────────
url + title + iconUrl         host + port + segments[] + allowExternal
אריח שהילד רואה               לאן מותר לנווט — לא מוצג לעולם
```

שניהם שורות באותו store, `siteEntries`, נבדלות ב-`kind`. **הניווט נבדק מול כל הכללים**,
לא רק מול הכלל של הקיצור שנפתח. **הוספת קיצור יוצרת אוטומטית כלל תואם.**

היקף: `prof:<profileId>` — פר פרופיל, לא פר ספרייה.

## 2. מפת הקוד

| שכבה | קובץ | מה יש בו |
|---|---|---|
| **גבול בטיחות** | [weblock.js](../www/js/weblock.js) | טהור. נרמול, השוואה, מועמדי כללים, חילוץ אייקון. **כל ההיגיון הקשה כאן.** |
| אחסון | [db.js](../www/js/db.js) | `siteEntries` store, `listSiteEntries` / `putSiteEntry` / `deleteSiteEntry`, מצבות ב-`meta['siteDel:<scope>']` |
| סנכרון | [drive.js](../www/js/drive.js) | `mergeSiteEntry` · `mergeDeletedSiteEntries` · `siteEntryOutlivesTombstone` · `planSiteApply` |
| גיבוי מקומי | [snapshot.js](../www/js/snapshot.js) | `sanitizeSnapshotSite` — **מריץ מחדש את גבול הבטיחות**, לא סומך על הקובץ |
| הגדרה | [settings.js](../www/js/settings.js) | `sitesEnabled` — per-profile, מסונכרן, **דלוק אלא אם נכתב**, תיקו → כבוי |
| גשר | [platform.js](../www/js/platform.js) | `openSiteViewer` / `closeSiteViewer` / `isSiteViewerOpen` / `clearSiteData` / `onSiteEvent` |
| UI + זרימות | [app.js](../www/js/app.js) | חפשו `==================== approved websites` ואת `refreshSitesPanel` |
| **אכיפה** | [KidsWebPlugin.java](../native-reference/KidsWebPlugin.java) | ה-WebView הנייטיבי. **המקום היחיד שבו ניווט באמת נחסם.** |
| מחזור חיים | [MainActivity.java](../native-reference/MainActivity.java) | רישום הפלאגין, `onBackPressed`, `onPause`/`onResume` |

בדיקות: [weblock.test.mjs](../test/weblock.test.mjs) (21) · הבלוק ב-`gdrive.test.mjs` ·
`sanitizeSnapshotSite` ב-`snapshot.test.mjs` · 18 שומרי wiring ב-`invariants.test.mjs`
(חפשו `v1.0.45`).

## 3. הזרימות

**הוספה** (שלוש דלתות, נתיב אחד). ה-confirm הוא **שאלה בעלת שלוש תשובות**: הוספה בלי
תוכן חיצוני (הכפתור הראשי, הבטוח), הוספה עם תוכן חיצוני, או ביטול. התשובה עוברת גם לכלל
שנוצר אוטומטית — אחרת ההורה אומר "כן" והדף נשאר מחמיר.
```
הקלדה/הדבקה  ─┐
כלל ידני      ─┼─→ canonicalSitePrefix → probeSite (עוקב הפניות, 8ש') → confirm שמראה
דף שנחסם      ─┘     מה יישמר בפועל → addSiteShortcut / addSiteRule → maybeSchedulePush
```

**פתיחה אצל הילד**: `openSiteForKid` → `armScheduledLock()` → `openSiteViewer({parentMode:false})`

**דף שנחסם**: הנייטיב מציג הודעה + כפתור "הורים" → `webAddRequest` → סגירת ה-overlay →
`startPin` → `askSiteRuleGrain` → `addSiteRule` → **`reopenForKid`** (ראו §4).

## 4. חמישה דברים שישברו בשקט

אלה לא כללי סגנון. כל אחד מהם היה באג אמיתי בפיתוח או ב-code review, ולכל אחד יש שומר
שהוכח אדום.

1. **פתיחה מחדש אחרי אישור חייבת להיות במצב ילד.** הזרימה מתחילה במסך של הילד: ההורה
   מקליד קוד, מאשר, ומחזיר את הטאבלט. `openSiteForParent` שם משאיר את הילד עם דפדפן
   חופשי — **הפיצ'ר מבוטל בדיוק ברגע שמתקנים אותו**. השתמשו ב-`reopenForKid`.
2. **`refreshSitesLauncher` חייבת לקרוא מחדש מה-DB.** גם ההגדרה וגם השורות מסונכרנות;
   קריאה ממטמון פירושה ששינוי ממכשיר אחר לא נכנס לתוקף עד החלפת פרופיל.
3. **`buildLocalDoc` — שני ענפים.** האתרים ברמת הפרופיל, ולענף `prof:` יש בלוק נפרד ודק
   יותר שנבנה רק אם יש סרטונים אישיים. לשכוח אותו = האתרים לא מסונכרנים בכלל, בשקט.
4. **הנעילה המתוזמנת חייבת לסגור את המציג לפני `nav.reset('locked')`.** ה-overlay נייטיבי
   ומעל הכל; אחרת המסך מתחלף מתחתיו והילד ממשיך לגלוש.
5. **`confirmKid` / `askKid` / `alertKid` מקבלות אובייקט**, לא ארגומנטים לפי סדר. קריאה
   פוזיציונית לא זורקת — היא מציירת דיאלוג ריק. יש שומר גורף על כל הריפו.
6. **WebView לא מממש מסך מלא לבד.** בלי `onShowCustomView` / `onHideCustomView` כפתור
   מסך-מלא של נגן מוטמע **לא עושה כלום** — בלי שגיאה ובלי לוג. כך זה נשלח. אם נוגעים
   ב-`RestrictedChromeClient`, אל תסירו אותם. ובזמן מסך מלא צריך גם `setKeepScreenOn`
   ופינג פעילות, אחרת סרטון של 20 דקות בלי נגיעה נראה כמו חוסר פעילות והמציג נסגר באמצע.
7. **אל תקראו את `siteEntries` דרך אינדקס.** `by_scope` הוא `['scopeId','order']`, ו-
   IndexedDB **משמיט רשומה מאינדקס** כשחסר רכיב במפתח שלה. שורה בלי `order` קיימת ב-store
   ובלתי-נראית לכל קורא, לנצח ובשקט — נמדד: `getAll()` החזיר שתי שורות ו-`listSiteEntries`
   אפס, כלומר משגר מוסתר ופאנל ריק מעל מסד מלא. קוראים לפי **המפתח הראשי**, ו-
   `putSiteEntry` חותם `order` בעצמו.
8. **פול שנוחת לא מרענן רק את הבית.** ההורה נמצא במסך ההורים בדיוק כשהוא בודק אם מה
   שהוסיף בטלפון הגיע. `renderAfterRemoteChange` מצייר את המסך שפעיל — ו**לא** קורא
   ל-`refreshParent()`, שמנקה שורות הודעה ומחזיר את הטאב.
9. **`shouldInterceptRequest` רץ מחוץ ל-UI thread** — היחיד מבין ה-callbacks של
   `WebViewClient`. קריאה ל-`web.` כלשהו משם היא **קריסה קטלנית**
   (`"called on thread 'WebViewCoreThread'"`), ואנדרואיד יאשים את ה-WebView ויציע
   למשתמש להסיר את עדכוניו. זה קרה בשטח, ורק במצב ילד — מצב הורה חוזר בשורה הראשונה של
   ה-hook. כל מה שהוא קורא חייב להיות שדה פשוט ו-`volatile`.

## 5. איך מוסיפים דברים

### שדה חדש לרשומה
1. `db.putSiteEntry` — לא צריך שינוי (blind upsert).
2. **`drive.mergeSiteEntry`** — אם השדה צריך תיקון-שובר משלו, הוסיפו אותו *אחרי* השוואת
   `updatedAt`, ובכיוון הבטוח (המגביל).
3. **`snapshot.sanitizeSnapshotSite`** — שדה שלא מסונן שם נכנס מקובץ שנערך ביד.
4. אם השדה הוא **per-device** (מטמון, חותמת מקומית) — אל תשימו אותו ברשומה. אין כאן
   מנגנון `stripPerDeviceChannel`; שימו אותו ב-`meta` (התקדים: `logofail:`).

### חסימה חדשה ב-WebView
1. הוסיפו ל-`KidsWebPlugin` **בשני העותקים** (`native-reference/` ו-`android/`).
2. הוסיפו שורה לטבלת `required` בשומר `the site viewer closes every escape` — עם **הדלת
   שהיא סוגרת**, לא רק שם ה-API.
3. `./gradlew :app:compileDebugJavaWithJavac` (צריך JDK 17).
4. בדקו על מכשיר. אין דרך אחרת.

### שינוי רמות ההרשאה (whole-site / section / page)
הכל ב-`weblock.ruleCandidatesFor`, טהור ובדוק. `defaultIndex` **אסור** שיצביע על
`whole-site`: הילד לחץ על קישור אחד, ופתיחת דומיין שלם היא יותר ממה שנשאל.

### נעילת containment על אתר / על דף (v1.0.76)
נעילת 'site' יש לה **גרעין** (`siteGrain`): `'host'` = כל האתר המאושר (התנהגות v1.0.67,
ברירת המחדל הבטוחה), `'prefix'` = הדף הנעול ותתי-הדפים שלו בלבד. הצמצום הוא ב-`weblock`:
`rulesForLockedSite` (host) מול `rulesForLockedPage` (prefix) — **שניהם מחזירים רשימת
`{host,port,segments}` רגילה, אז הצד הנייטיבי לא משתנה.** `openLockedSite` בוחר לפי
`containState.siteGrain`. הגרעין נשמר ב-`contain:<pid>:sitegrain` ושורד ריסטארט;
`evalContainment` מפרש כל ערך שאינו `'prefix'` כ-`'host'` — **לעולם לא נועלים ילד על דף
בשקט**. השאלה "כל האתר / רק הדף הזה" היא `plan.siteLockGrain` (ok→host, third→prefix).
"צלילה פנימה" = נעילה-מחדש (feature 3) על הדף הנוכחי (`lockCandidateSiteUrl`), עם תחילית
צרה יותר. `rulesForLockedPage` **רק מצמצם, לעולם לא מעניק** — `matchRule` מבטיח שה-segments
של הכלל השולט הם תחילית של הדף, כך שהכלל הסינתטי הוא תת-קבוצה.
⚠️ `onSiteLockTap`'s `onDone` **חייב לקרוא את הבוליאן** (`(ok) => …`), לא דגל `settled`:
`consumePinDone(true)` מפעיל את onDone **לפני** `pinOnSuccess`, אז דגל היה נקרא false
בהצלחה והאתר היה נפתח מחדש מעל דיאלוג הזמן.

### לשנות את שאלת התוכן החיצוני
היא יושבת ב-`runSiteAdd` ומועברת דרך `addSiteShortcut` → `addSiteRule`. אם מוסיפים
תשובה רביעית — `askKid` נותן שלושה כפתורים בלבד; דיאלוג שני יהיה הדרך.

### אתר שדורש התחברות
כלום בקוד. ההורה לוחץ "כניסה / בדיקה" בפאנל → `parentMode:true` → ניווט לא מוגבל →
מתחבר → העוגיות נשמרות (`CookieManager.flush()`) → הילד יורש את הסשן.
⚠️ SSO ל-host אחר עובד **רק** במצב הורה; במצב ילד הוא נחסם, וזה מכוון.

## 6. איך מדבגים

| שאלה | איפה לבדוק |
|---|---|
| למה הכתובת נחסמה? | `sites-blocked-box` בפאנל ההורים; ו-`adb logcat` ל-`webBlocked` |
| למה הכפתור לא מופיע? | `sitesEnabled`, ספירת ה-shortcuts, ו-`html.tv` — שלושתם ב-`refreshSitesLauncher` |
| למה האתר לא מסונכרן? | האם הבלוב `prof:<id>` נבנה בכלל (§4.3) |
| השורה ב-DB אבל לא על המסך | האם `getActiveProfile()` מחזיר פרופיל — בלי פרופיל פעיל `siteScope()` הוא null והרשימה ריקה |
| הכלל לא תופס? | `canonicalSitePrefix(url)` בקונסול — השוו `display` לזה ששמור |
| האייקון 🌐 במקום תמונה | `db.getThumbRecord('siteicon:<entryId>')`; `iconUrl` ריק = ה-probe לא הצליח |

בקונסול של הדפדפן: `(await import('/js/db.js')).listSiteEntries('prof:<id>')`.

## 7. מה לא ניתן לבדוק בדפדפן

**המציג עצמו** — הוא נייטיבי, ובדפדפן מוצגת הודעה מפורשת (לא iframe: iframe לא יכול
לאכוף כלום, וחצי מהאתרים מסרבים להיטען בו). כל השאר כן נבדק בדפדפן.

רשימת המכשיר: כל אחת מתשע החסימות בנפרד · מסלול הדף החסום מקצה לקצה · התחברות במצב הורה
ואימות שהילד נשאר מחובר **אחרי הרג התהליך** (זה מה שמוכיח את `flush()`) · פקיעת מצב הורה
אחרי דקה ברקע · כיבוי מסך באמצע אתר **עם אודיו** · נעילה מתוזמנת בזמן שהמציג פתוח.

## 8. מגבלות ידועות

- **SSO במצב ילד נחסם** — לפי התכנון. ההתחברות היא פעולה הורית.
- **`clearSiteData` אינו כירורגי** — ל-`CookieManager` אין מחיקה per-host, אז העוגיות
  מפוגגות לפי שם מול אותו host וה-DOM storage המשותף נמחק כולו.
- **הפיצ'ר מוסתר ב-Android TV** — אתרים לא נגישים ב-D-pad. הפאנל כן מוצג.
- **אחרי התחברות הילד בתוך סשן מחובר.** הכללים מגבילים לאן אפשר להגיע, אך בתוך המותר
  הילד פועל כמשתמש המחובר. נאמר להורה בפאנל.
- **מצב "מחמיר" עלול לשבור אתרים** שמשתמשים ב-CDN חיצוני. המתג per-rule הוא המוצא.
- **"בדיקה" אינה תצוגה מקדימה של מה שהילד רואה** — היא רצה ב-`parentMode`, כלומר בלי
  סינון תוכן חיצוני, כי היא גם דלת ההתחברות. נאמר בפאנל.
- **אין מגבלת גודל** על הדף שה-probe מוריד (יש רק מגבלת זמן).
- **מסך מלא של סרטון מוטמע דורש "תוכן חיצוני"** — הנגן עצמו הוא משאב צד-ג', אז במצב
  מחמיר הוא לא נטען מלכתחילה.

## 9. מה שנשקל ונדחה

| רעיון | למה לא |
|---|---|
| `<iframe>` במקום WebView נייטיבי | לא יכול לאכוף ניווט (same-origin), ו-`X-Frame-Options` חוסם חלק גדול מהרשת |
| Chrome Custom Tabs | דפדפן אמיתי, אפס hooks |
| Activity שנייה למציג | מתנגשת עם lock-task (הנעילה הקיוסקית) וצריכה immersive משלה |
| public-suffix list לתת-משאבים | מיותר — עוגנים על ה-host המלא שנשמר, לא על ניחוש eTLD+1 |
| אימות ה-PIN בג'אווה | מימוש שני של בדיקת האבטחה היחידה ששומרת על מסך ההורים |
| אתרים ב-`libraryChannels` (תעלול v1.0.26) | היה מחייב ~10 מסנני `kind` הגנתיים בקוד שאין לו קשר לאתרים |
| האתרים בקובץ הרשימה | הפורמט מבטיח "אין parser שני ואין גבול בטיחות שני" |
| סגירת מצב הורה ב-`onPause` | הופכת קפיצה למנהל סיסמאות לבלתי אפשרית; לכן פקיעה ב-resume |
