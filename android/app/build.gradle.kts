plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

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
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
