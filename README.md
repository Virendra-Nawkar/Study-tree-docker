# StudyTree – Dockerized Full‑Stack Application

A **Dockerized full‑stack project** with:

* ⚛️ **React** frontend
* 🟢 **Node.js / Express** backend
* 🐳 **Docker & Docker Compose** for containerization

This repository allows **anyone to run the entire project with a single command** using Docker.

---

## 📁 Project Structure

```bash
.
├── backend
│   ├── Dockerfile.backend
│   ├── package.json
│   ├── server.js
│   ├── uploads
│   └── temp
├── frontend
│   ├── Dockerfile.frontend
│   ├── package.json
│   ├── public
│   └── src
├── docker-compose.yml
└── README.md
```

---

## 🚀 Tech Stack

* **Frontend:** React (CRA)
* **Backend:** Node.js, Express
* **Containerization:** Docker, Docker Compose
* **OS Support:** macOS, Linux, Windows

---

## ✅ Prerequisites

Make sure you have:

* **Docker Desktop** installed
* Docker Compose (included with Docker Desktop)

Check installation:

```bash
docker --version
docker compose version
```

---

## ▶️ How to Run the Project (One Command)

### 1️⃣ Clone the repository

```bash
git clone https://github.com/Virendra-Nawkar/Study-tree-docker.git
cd Study-tree-docker
```

---

### 2️⃣ Build & start containers

```bash
docker compose up --build
```

⏳ First run may take a few minutes.

---

### 3️⃣ Access the application

* 🌐 **Frontend:** [http://localhost:3000](http://localhost:3000)
* ⚙️ **Backend:** [http://localhost:5001](http://localhost:5001)

---

### 4️⃣ Stop the application

Press:

```text
CTRL + C
```

Or run:

```bash
docker compose down
```

---

## 🔁 Re‑run (without rebuilding)

```bash
docker compose up
```

---

## 🐳 Docker Services Overview

| Service  | Description              | Port |
| -------- | ------------------------ | ---- |
| frontend | React development server | 3000 |
| backend  | Node.js / Express API    | 5001 |

Each service runs in its **own container** (industry best practice).

---

## ❗ Common Issues & Fixes

### Port already in use

```bash
lsof -i :3000
lsof -i :5001
```

Change ports in `docker-compose.yml` if needed.

---

### Docker not running

Start **Docker Desktop** and retry.

---

## 🧠 Why Docker Compose?

* One‑command setup
* Same environment for everyone
* Easy collaboration
* Production‑ready architecture

> 🏆 **Interview Tip:**
> “I containerized a full‑stack React + Node application using Docker and Docker Compose with separate services.”

---

## 🔐 Security Notes

* ❌ Do not commit `.env` files
* ❌ Do not commit `node_modules`
* ✔️ Docker handles dependency isolation

---

## 📌 Future Improvements

* Production build with **NGINX**
* CI/CD using **GitHub Actions**
* Database container (MongoDB/PostgreSQL)
* Kubernetes deployment

---

## 👤 Author

**Virendra Nawkar**

* GitHub: [https://github.com/Virendra-Nawkar](https://github.com/Virendra-Nawkar)

---

## ⭐ If you like this project

Give it a **star ⭐** on GitHub!

Happy Coding 🚀
