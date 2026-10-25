import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

/**
 * Release signing, from the environment (CI: `ANDROID_KEYSTORE`, a path, and `ANDROID_KEYSTORE_PASSWORD`,
 * `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) or, on a computer, android/keystore.properties with
 * `storeFile`, `storePassword`, `keyAlias` and `keyPassword` (never committed). Without either, release
 * builds are unsigned.
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}
fun signingValue(env: String, property: String): String? =
    providers.environmentVariable(env).orNull?.takeIf { it.isNotEmpty() } ?: keystoreProperties.getProperty(property)
val releaseKeystore = signingValue("ANDROID_KEYSTORE", "storeFile")

android {
    namespace = "org.nexlibris.app"
    compileSdk = 36
    // The installed build tools, rather than AGP's default.
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "org.nexlibris.app"
        // java.nio.file (atomic moves) and java.util.Base64 need 26.
        minSdk = 26
        targetSdk = 36
        // A release's, from its tag (scripts/release/version.mjs): -PversionCode=… -PversionName=…
        versionCode = providers.gradleProperty("versionCode").orNull?.toInt() ?: 1
        versionName = providers.gradleProperty("versionName").orNull ?: "0.0.0-dev"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = rootProject.file(releaseKeystore)
                storePassword = signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("ANDROID_KEY_ALIAS", "keyAlias")
                keyPassword = signingValue("ANDROID_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webapp"))
}

/** The web app, built by `npm run build` at the repository root, packaged as assets/www. */
val webAppDist = rootProject.layout.projectDirectory.dir("../client/dist")

val copyWebApp by tasks.registering(Sync::class) {
    description = "Copies the built web app (client/dist) into the app's assets."
    from(webAppDist)
    into(layout.buildDirectory.dir("generated/webapp/www"))
    doFirst {
        check(webAppDist.file("index.html").asFile.isFile) {
            "No web app build at ${webAppDist.asFile}. Run `npm run build` in the repository root first."
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation(libs.androidx.webkit)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
