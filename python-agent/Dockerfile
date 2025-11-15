FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libavdevice-dev \
    libavfilter-dev \
    libavformat-dev \
    libavcodec-extra \
    libopus-dev \
    libvpx-dev \
    && apt-get clean

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY python_service.py ./

ENV PORT=8030
EXPOSE 8030

CMD ["python", "python_service.py"]






# FROM python:3.11-slim

# RUN apt-get update && apt-get install -y \
#     ffmpeg \
#     libavdevice-dev \
#     libavfilter-dev \
#     libavformat-dev \
#     libavcodec-extra \
#     libopus-dev \
#     libvpx-dev \
#     && apt-get clean

# WORKDIR /app

# COPY requirements.txt .
# RUN pip install --no-cache-dir -r requirements.txt

# COPY python_service.py .

# ENV PORT=8030

# CMD ["python", "python_service.py"]



# # FROM python:3.10-slim

# # RUN apt-get update && apt-get install -y \
# #     ffmpeg libavcodec-extra libavdevice-dev libavfilter-dev libavformat-dev \
# #     libavutil-dev libswresample-dev libswscale-dev && \
# #     apt-get clean

# # WORKDIR /app

# # COPY requirements.txt .
# # RUN pip install --no-cache-dir -r requirements.txt

# # COPY python_service.py .

# # CMD ["python", "python_service.py"]
