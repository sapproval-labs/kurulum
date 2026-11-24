---
description: Sapproval Labs'ı kurulum kodunuzla kurar
argument-hint: <kurulum kodu, ör. ABCD-EFGH-JKLM>
allowed-tools: Bash(node:*), Bash(winget:*)
---

Kullanıcı Sapproval Labs'ı kurmak istiyor. Kurulum kodu: `$ARGUMENTS`

Türkçe, kısa ve sade konuş; kullanıcı teknik olmayabilir.

1. Kod boşsa kullanıcıdan davet e-postasındaki kurulum kodunu iste (ör. ABCD-EFGH-JKLM) ve dur.
2. Şunu çalıştır:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/kur.js" $ARGUMENTS
   ```

3. Çıktının son satırı JSON'dur (`{"ok": ..., "need"?: ..., "manual"?: [...], "error"?: ...}`); önceki satırlar
   ilerlemeyi gösterir ("ℹ" ile başlayan satırları da kullanıcıya ilet):
   - `"need": "node"`: Node.js yok ya da eski (22.19 veya üstü gerekli). Kullanıcıya Node.js'in kurulacağını söyle, onay
     verirse `winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements`
     çalıştır, sonra kullanıcıdan Claude'u kapatıp açmasını ve `/kurulum:kur <kod>` komutunu tekrar yazmasını iste.
   - `"need": "git"`: aynı şekilde `Git.Git` paketiyle.
   - `"manual"` listesi doluysa: bu satırları kullanıcıya kod bloğu olarak ver ve sohbet kutusuna sırayla yazmasını iste
     (sen slash komutu çalıştıramazsın). Yazdıktan sonra `/kurulum:kur` komutunu tekrar yazmasını söyle; kurulum kaldığı yerden devam eder.
   - `"ok": true`: kurulumun tamamlandığını söyle. Kullanıcı Claude uygulamasını tamamen kapatıp yeniden açsın ve
     sohbet kutusuna `/sapproval:setup` yazarak SAP sistemini tanımlasın.
   - Diğer hatalarda `error` metnini olduğu gibi ilet; kod geçersizse ekip yöneticisinden ya da Sapproval Ekibi'nden yeni kod istemesini söyle.
4. Kurulum kodunu, çıktıdaki anahtarları veya dosya içeriklerini başka hiçbir yere yazma veya gönderme.
