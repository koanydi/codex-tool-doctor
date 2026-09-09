# 仅供回环测试的TLS证书

这些证书与server-key.pem是公开测试夹具，用于验证HTTPS信任成功与默认拒绝分支。证书标注TEST ONLY，SAN为127.0.0.1与localhost；不要用于实际服务。签发CA的私钥不在仓库中。

需要更换夹具时，用独立测试CA生成CA证书，签发含`subjectAltName=IP:127.0.0.1,DNS:localhost`的服务证书。只保留CA公钥证书、服务证书和测试服务私钥，并删除CA私钥；运行`node --test test/https.test.mjs`确认信任与拒绝路径。

运行时不会读取此目录，用户发布包也不包含它。
